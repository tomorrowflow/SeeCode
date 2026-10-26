import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBoards, refreshBoard, readState } from '../boards.mjs';
import { createHandler } from '../http.mjs';

const spec = (label) => JSON.stringify({
  type: 'architecture', title: 'Server',
  nodes: [{ id: 'app', label, row: 0, col: 0 }, { id: 'db', label: 'Postgres', row: 0, col: 1 }],
  edges: [['app', 'db', 'writes']],
  evidence: [{ id: 'app', file: 'server/app.py', line: 12 }],
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'seecode-viewer-repo-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  mkdirSync(join(dir, 'docs/architecture'), { recursive: true });
  mkdirSync(join(dir, '.seecode'));
  writeFileSync(join(dir, '.seecode/config.json'), '{"fonts":"system"}\n');
  const commit = (body, msg) => {
    writeFileSync(join(dir, 'docs/architecture/server.json'), body);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit };
}

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // fetch() drops a custom Host header, and the Host check is what's under test.
  const get = (path, host = 'localhost') => new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c) => { body += c; }).on('end', () => resolve({ status: res.statusCode, text: async () => body }));
    }).on('error', reject).end();
  });
  return { get, close: () => server.close() };
}

test('parseBoards defaults and rejects unsafe config', () => {
  const [b] = parseBoards('{"voice-diary":{"repo":"/repos/vd","github":"tomorrowflow/voice-diary"}}');
  assert.deepEqual(b, { id: 'voice-diary', repo: '/repos/vd', ref: 'origin/HEAD', specDir: 'docs/architecture', github: 'tomorrowflow/voice-diary', driftIgnore: [] });
  assert.throws(() => parseBoards('{"x":{"repo":"/r","specDir":"../etc"}}'), /bad specDir/);
  assert.throws(() => parseBoards('{"../x":{"repo":"/r"}}'), /board id/);
  assert.throws(() => parseBoards('[]'), /object keyed/);
  assert.throws(() => parseBoards('{"x":{"repo":"/r","driftIgnore":"docs"}}'), /driftIgnore/);
});

test('renders the ref, keeps the last good map when a newer commit breaks, and serves it', async () => {
  const r = repo();
  const good = r.commit(spec('API'), 'good');
  const data = mkdtempSync(join(tmpdir(), 'seecode-viewer-data-'));
  const [board] = parseBoards(JSON.stringify({ vd: { repo: r.dir, ref: 'HEAD', github: 'acme/vd' } }));

  const first = refreshBoard(board, data);
  assert.equal(first.commit, good, 'serves the ref commit');
  assert.equal(first.error, null);
  assert.equal(refreshBoard(board, data).renderedAt, first.renderedAt, 'an unchanged ref is not re-rendered');

  const bad = r.commit('{"type":"architecture","nodes":"broken"}', 'bad');
  const after = refreshBoard(board, data);
  assert.equal(after.commit, good, 'still serves the last good commit');
  assert.equal(after.error.commit, bad, 'records the failing commit');
  assert.deepEqual(readdirSync(join(data, 'vd')).filter((n) => n !== 'state.json'), [good], 'only the served render stays on disk');

  const { get, close } = await serve(createHandler({ boards: [board], dataDir: data, allowHosts: ['localhost'] }));
  try {
    assert.equal((await get('/board/vd/', 'evil.example')).status, 403, 'other hosts are refused');
    const index = await (await get('/board/vd/')).text();
    assert.match(index, new RegExp(good.slice(0, 7)), 'header names the served commit');
    assert.match(index, /Last render failed/, 'header shows the newer failure');
    const diagram = await (await get('/board/vd/server.html')).text();
    assert.match(diagram, new RegExp(`https://github.com/acme/vd/blob/${good}/`), 'evidence links to the served commit');
    assert.equal((await get('/board/vd/..%2F..%2Fstate.json')).status, 404, 'no path escapes the served folder');
    assert.equal((await get('/board/vd')).status, 301);
    assert.equal((await get('/board/vd/drift.json')).status, 404, 'no drift report yet');
    assert.equal((await get('/board/nope/')).status, 404);
  } finally { close(); }
});

test('a board whose ref has no spec folder yet shows a waiting page', async () => {
  const r = repo();
  execFileSync('git', ['-C', r.dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'empty']);
  const data = mkdtempSync(join(tmpdir(), 'seecode-viewer-data-'));
  const [board] = parseBoards(JSON.stringify({ vd: { repo: r.dir, ref: 'HEAD' } }));
  const state = refreshBoard(board, data);
  assert.equal(state.commit, undefined);
  assert.match(state.error.message, /no docs\/architecture/);
  assert.ok(!existsSync(join(data, 'vd', 'index.html')));
  const { get, close } = await serve(createHandler({ boards: [board], dataDir: data, allowHosts: ['localhost'] }));
  try {
    const res = await get('/board/vd/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /No map yet/);
    assert.equal(readState(data, 'vd').error.commit !== null, true);
  } finally { close(); }
});
