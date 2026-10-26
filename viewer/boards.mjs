// Renders each board's specs from a read-only clone at the board's ref. A board
// keeps serving its last good render while a newer commit fails, and its state
// survives restarts in <data>/<board>/state.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SC = fileURLToPath(new URL('../skills/seecode/scripts/seecode.mjs', import.meta.url));
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function parseBoards(json) {
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('boards config must be an object keyed by board id');
  return Object.entries(raw).map(([id, b]) => {
    if (!BOARD_ID.test(id)) throw new Error(`board id "${id}" must be letters, digits, - or _`);
    if (!b || typeof b.repo !== 'string' || !b.repo) throw new Error(`board ${id} needs "repo"`);
    const specDir = String(b.specDir ?? 'docs/architecture').replace(/^\/+|\/+$/g, '');
    if (!specDir || specDir.split('/').some((p) => p === '..' || p === '.')) throw new Error(`board ${id} has a bad specDir`);
    if (b.github !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(b.github)) throw new Error(`board ${id} github must be owner/name`);
    const driftIgnore = b.driftIgnore ?? [];
    if (!Array.isArray(driftIgnore) || driftIgnore.some((x) => typeof x !== 'string' || !x)) throw new Error(`board ${id} driftIgnore must be a list of names or paths`);
    return { id, repo: b.repo, ref: b.ref ?? 'origin/HEAD', specDir, github: b.github, driftIgnore };
  });
}

// The clone is mounted read-only and owned by another uid, hence safe.directory.
export function git(repo, args, encoding = 'utf8') {
  const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', repo, ...args], { encoding, maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

export function readState(dataDir, id) {
  try { return JSON.parse(readFileSync(join(dataDir, id, 'state.json'), 'utf8')); } catch { return {}; }
}

function saveState(dataDir, id, state) {
  const p = join(dataDir, id, 'state.json');
  mkdirSync(join(dataDir, id), { recursive: true });
  writeFileSync(`${p}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
  return state;
}

// The folder a board's pages are served from, or null before its first render.
export function servedDir(board, dataDir, state) {
  return state.commit ? join(dataDir, board.id, state.commit, board.specDir) : null;
}

function exportTree(board, sha, root) {
  const paths = [board.specDir];
  if (git(board.repo, ['ls-tree', '--name-only', sha, '.seecode']).trim()) paths.push('.seecode');
  const tar = git(board.repo, ['archive', '--format=tar', sha, '--', ...paths], 'buffer');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const x = spawnSync('tar', ['-x', '-C', root], { input: tar });
  if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
}

function render(dir, cwd) {
  const r = spawnSync(process.execPath, [SC, 'render', dir], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: false, error: (r.stderr || 'render printed no JSON').trim() }; }
}

const problemsOf = (result) => (result.diagrams || []).filter((d) => !d.ok || d.problems).map((d) => ({ spec: d.spec, ...(d.error ? { error: d.error } : {}), ...(d.problems ? { problems: d.problems } : {}) }));

// One pass for one board: render the ref's commit if it is new. Idempotent: a
// commit already served, or already known to fail, is not rendered again.
export function refreshBoard(board, dataDir, now = Date.now()) {
  const state = readState(dataDir, board.id);
  let sha;
  try {
    sha = git(board.repo, ['rev-parse', '--verify', `${board.ref}^{commit}`]).trim();
  } catch (e) {
    return saveState(dataDir, board.id, { ...state, error: { commit: null, at: now, message: e.message } });
  }
  if (sha === state.commit || sha === state.error?.commit) return state;

  if (!git(board.repo, ['ls-tree', '--name-only', sha, board.specDir]).trim()) {
    return saveState(dataDir, board.id, { ...state, error: { commit: sha, at: now, message: `no ${board.specDir} at ${sha.slice(0, 7)}` } });
  }
  const root = join(dataDir, board.id, sha);
  let result;
  try {
    exportTree(board, sha, root);
    result = render(join(root, board.specDir), root);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  const failure = result.ok ? null : { commit: sha, at: now, message: result.error || `${result.rendered ?? 0} of ${result.count ?? '?'} specs rendered`, problems: problemsOf(result) };
  const next = result.ok || !state.commit
    ? { commit: sha, renderedAt: now, warnings: problemsOf(result), error: failure }
    : { ...state, error: failure };
  for (const d of readdirSync(join(dataDir, board.id), { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== next.commit) rmSync(join(dataDir, board.id, d.name), { recursive: true, force: true });
  }
  return saveState(dataDir, board.id, next);
}

export const hasMap = (board, dataDir, state) => {
  const dir = servedDir(board, dataDir, state);
  return Boolean(dir && existsSync(join(dir, 'index.html')));
};
