import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBoards, refreshBoard } from '../boards.mjs';
import { driftOf, driftReport, writeReport } from '../drift.mjs';

const SPEC = {
  type: 'architecture', title: 'Server',
  nodes: [{ id: 'api', label: 'API', row: 0, col: 0 }, { id: 'db', label: 'Postgres', kind: 'store', row: 0, col: 1 }],
  edges: [['api', 'db', 'writes']],
  evidence: [{ id: 'api', file: 'server/app.py', line: 2 }, { id: 'db', file: 'server/db.py', line: 1 }],
};

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'seecode-drift-tree-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const CODE = { 'server/app.py': 'import db\napp = 1\n', 'server/db.py': 'import psycopg\n' };

test('a spec that matches its code is clean', () => {
  const d = driftOf({ root: tree({ ...CODE, 'docs/architecture/server.json': SPEC }), specDir: 'docs/architecture', ignore: ['docs'] });
  assert.deepEqual(d.render, [{ spec: 'server', ok: true, codes: [] }]);
  assert.deepEqual([d.staleEvidence, d.unmapped, d.unevidenced], [[], [], []]);
  assert.equal(d.summary.clean, true);
  assert.equal(d.summary.text, 'Clean: 1 specs match the code.');
});

test('evidence for a deleted file or a line past the end is stale', () => {
  const spec = { ...SPEC, evidence: [{ id: 'api', file: 'server/app.py', line: 3 }, { id: 'db', file: 'server/gone.py', line: 1 }] };
  const d = driftOf({ root: tree({ ...CODE, 'docs/architecture/server.json': spec }), specDir: 'docs/architecture', ignore: ['docs'] });
  assert.deepEqual(d.staleEvidence, [
    { spec: 'server', id: 'api', file: 'server/app.py', line: 3, reason: 'line-past-end', lines: 2 },
    { spec: 'server', id: 'db', file: 'server/gone.py', line: 1, reason: 'missing-file' },
  ]);
  assert.equal(d.summary.text, '2 stale evidence.');
});

test('a module no spec cites is unmapped unless ignored, and compose volumes are not services', () => {
  const files = {
    ...CODE,
    'worker/jobs.py': 'x = 1\n',
    'deploy/compose.yml': 'services:\n  api:\n    image: x\n  cache:\n    image: redis\nvolumes:\n  pgdata:\n',
    'docs/architecture/server.json': SPEC,
  };
  const d = driftOf({ root: tree(files), specDir: 'docs/architecture', ignore: ['docs'] });
  assert.deepEqual(d.unmapped.map((u) => `${u.kind}:${u.name}`).sort(), ['infra:cache', 'module:worker']);
  assert.ok(!driftOf({ root: tree(files), specDir: 'docs/architecture', ignore: ['docs', 'worker'] }).unmapped.some((u) => u.name === 'worker'));
});

test('render problems and nodes without evidence are reported', () => {
  const spec = { ...SPEC, nodes: [...SPEC.nodes, { id: 'q', label: 'x'.repeat(60), row: 1, col: 0 }, { id: 'maybe', label: 'Maybe', kind: 'optional', row: 1, col: 1 }] };
  const d = driftOf({ root: tree({ ...CODE, 'docs/architecture/server.json': spec }), specDir: 'docs/architecture', ignore: ['docs'] });
  assert.equal(d.render[0].ok, false);
  assert.deepEqual(d.render[0].codes, ['E_SPEC']);
  assert.deepEqual(d.unevidenced, [{ spec: 'server', id: 'q', label: 'x'.repeat(60) }]);
  assert.match(d.summary.text, /^1 spec fails to render/);
});

test('the report is computed at the served commit and served next to the map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seecode-drift-repo-'));
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  for (const [path, body] of Object.entries({ ...CODE, 'docs/architecture/server.json': JSON.stringify(SPEC) })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'map');
  const specCommit = git('rev-parse', 'HEAD');
  const data = mkdtempSync(join(tmpdir(), 'seecode-drift-data-'));
  const [board] = parseBoards(JSON.stringify({ vd: { repo: dir, ref: 'HEAD', driftIgnore: ['docs'] } }));
  refreshBoard(board, data);
  git('rm', '-q', 'server/db.py');
  git('commit', '-q', '-m', 'drop db');
  refreshBoard(board, data);

  const report = driftReport(board, data, Date.UTC(2026, 9, 26));
  assert.equal(report.commit, git('rev-parse', 'HEAD'));
  assert.equal(report.lastSpecChange.commit, specCommit);
  assert.equal(report.generatedAt, '2026-10-26T00:00:00.000Z');
  assert.deepEqual(report.staleEvidence.map((s) => s.reason), ['missing-file']);
  writeReport(data, 'vd', report);
  assert.equal(JSON.parse(readFileSync(join(data, 'vd', 'drift.json'), 'utf8')).summary.text, '1 stale evidence.');
});
