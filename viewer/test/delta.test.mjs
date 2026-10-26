import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoards, refreshBoard, specHistory } from '../boards.mjs';
import { diffSpecSets, deltaReport } from '../delta.mjs';
import { createHandler } from '../http.mjs';

const V1 = {
  type: 'architecture', title: 'Server',
  nodes: [{ id: 'api', label: 'API', row: 0, col: 0 }, { id: 'db', label: 'Postgres', row: 0, col: 1 }],
  edges: [['api', 'db', 'writes']],
  evidence: [{ id: 'api', file: 'server/app.py', line: 2 }],
};
const V2 = {
  ...V1,
  nodes: [{ id: 'api', label: 'HTTP API', row: 0, col: 0 }, { id: 'db', label: 'Postgres', row: 1, col: 1 }, { id: 'cache', label: 'Redis', row: 0, col: 2 }],
  edges: [['api', 'db', 'reads'], ['api', 'cache', 'caches']],
  evidence: [{ id: 'api', file: 'server/app.py', line: 5 }, { id: 'cache', file: 'server/cache.py', line: 1 }],
};

test('a structural diff names added, removed, relabelled and moved parts', () => {
  const d = diffSpecSets(new Map([['server', V1], ['old', V1]]), new Map([['server', V2], ['ios', V1]]));
  assert.deepEqual(d.specs.map((s) => [s.spec, s.status]), [['ios', 'added'], ['old', 'removed'], ['server', 'changed']]);
  const s = d.specs[2];
  assert.deepEqual(s.nodes, {
    added: [{ id: 'cache', label: 'Redis' }],
    removed: [],
    changed: [{ id: 'api', fields: { label: ['API', 'HTTP API'] } }],
    moved: [{ id: 'db', from: [0, 1], to: [1, 1] }],
  });
  assert.deepEqual(s.edges, { added: [{ edge: 'api>cache', label: 'caches' }], removed: [], changed: [{ edge: 'api>db', label: ['writes', 'reads'] }] });
  assert.deepEqual(s.evidence, {
    added: [{ id: 'cache', file: 'server/cache.py', line: 1 }],
    removed: [],
    moved: [{ id: 'api', file: 'server/app.py', line: [2, 5] }],
  });
  assert.equal(d.summary.text, '1 spec added (ios); 1 removed; server: +1 node, 1 relabelled, +1 edge.');
});

test('identical specs are no change', () => {
  const d = diffSpecSets(new Map([['server', V1]]), new Map([['server', structuredClone(V1)]]));
  assert.deepEqual(d.specs, []);
  assert.equal(d.summary.text, 'No spec changes.');
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'seecode-delta-repo-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  mkdirSync(join(dir, 'docs/architecture'), { recursive: true });
  mkdirSync(join(dir, 'server'), { recursive: true });
  const commit = (files, msg, date) => {
    for (const [p, body] of Object.entries(files)) {
      if (body === null) rmSync(join(dir, p));
      else writeFileSync(join(dir, p), typeof body === 'string' ? body : JSON.stringify(body));
    }
    git('add', '-A');
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

test('a date window covers the spec commits made inside it', () => {
  const r = repo();
  r.commit({ 'docs/architecture/server.json': V1, 'server/app.py': 'x\n' }, 'map v1', '2026-10-12T10:00:00Z');
  const v2 = r.commit({ 'docs/architecture/server.json': V2 }, 'map v2', '2026-10-20T10:00:00Z');
  r.commit({ 'server/app.py': 'y\n' }, 'code only', '2026-10-21T10:00:00Z');
  const [board] = parseBoards(JSON.stringify({ vd: { repo: r.dir, ref: 'HEAD' } }));

  const week = deltaReport(board, { since: '2026-10-19T00:00:00+02:00', until: '2026-10-26T00:00:00+01:00' });
  assert.deepEqual(week.specCommits.map((c) => c.subject), ['map v2']);
  assert.equal(week.summary.text, 'server: +1 node, 1 relabelled, +1 edge.');
  assert.deepEqual(specHistory(board).map((c) => c.subject), ['map v2', 'map v1']);

  const quiet = deltaReport(board, { since: '2026-10-26T00:00:00+01:00', until: '2026-11-02T00:00:00+01:00' });
  assert.equal(quiet.summary.unchanged, true);
  assert.deepEqual(quiet.specCommits, []);

  const first = deltaReport(board, { since: '2026-10-05T00:00:00+02:00', until: '2026-10-19T00:00:00+02:00' });
  assert.equal(first.from, null);
  assert.equal(first.summary.text, '1 spec added (server).');
  assert.equal(deltaReport(board, { to: v2 }).to.commit, v2);
});

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const get = (path) => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host: 'localhost' } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => { body += c; }).on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });
  return { get, close: () => server.close() };
}

test('the picker lists spec commits, a past commit serves its own map, and delta shows the last change', async () => {
  const r = repo();
  const v1 = r.commit({ 'docs/architecture/server.json': V1, 'server/app.py': 'x\n' }, 'map v1', '2026-10-12T10:00:00Z');
  const v2 = r.commit({ 'docs/architecture/server.json': V2 }, 'map v2', '2026-10-20T10:00:00Z');
  const data = mkdtempSync(join(tmpdir(), 'seecode-delta-data-'));
  const [board] = parseBoards(JSON.stringify({ vd: { repo: r.dir, ref: 'HEAD', github: 'acme/vd' } }));
  refreshBoard(board, data);
  const s = await serve(createHandler({ boards: [board], dataDir: data, allowHosts: ['localhost'] }));
  try {
    const index = await s.get('/board/vd/');
    assert.match(index.body, new RegExp(`<option value="/board/vd/at/${v1}/">2026-10-12 ${v1.slice(0, 7)} map v1</option>`));
    assert.match(index.body, /What changed last/);

    const old = await s.get(`/board/vd/at/${v1}/`);
    assert.equal(old.status, 200);
    assert.match(old.body, /Older map from 2026-10-12/);
    assert.match(old.body, new RegExp(`<option value="/board/vd/at/${v1}/" selected>`));
    const diagram = await s.get(`/board/vd/at/${v1}/server.html`);
    assert.match(diagram.body, new RegExp(`https://github.com/acme/vd/blob/${v1}/`));
    assert.equal((await s.get(`/board/vd/at/${'0'.repeat(40)}/`)).status, 404);

    const delta = await s.get('/board/vd/delta');
    assert.equal(delta.status, 200);
    assert.match(delta.body, /server: \+1 node, 1 relabelled, \+1 edge\./);
    assert.match(delta.body, /node added: <b>Redis<\/b>/);
    const json = JSON.parse((await s.get(`/board/vd/delta.json?from=${v1}&to=${v2}`)).body);
    assert.equal(json.to.commit, v2);
    assert.equal((await s.get('/board/vd/delta?to=--output=x')).status, 400);
  } finally {
    s.close();
  }
});
