#!/usr/bin/env node
// Drift report for one board: how far the specs at the commit the viewer serves
// have drifted from the code at that same commit. Deterministic, no model calls;
// the factory's gardener reads the report and decides what is worth a card.
//   node viewer/drift.mjs --board <id>
// Prints the report as JSON and writes it to <data>/<id>/drift.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, parseBoards, readState } from './boards.mjs';

const SC = fileURLToPath(new URL('../skills/seecode/scripts/seecode.mjs', import.meta.url));

export const MATCH_RULES = {
  module: 'mapped when an evidence file is under the module directory, or a node id or label equals its name',
  tech: 'mapped when a node id, label, sub or tag contains the tech name, or an evidence entry cites its file',
  infra: 'a compose service is mapped when a node id, label, sub or tag contains its name; any other infra file when an evidence entry cites it',
};

function seecode(args, cwd) {
  const r = spawnSync(process.execPath, [SC, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: false, error: (r.stderr || 'printed no JSON').trim() }; }
}

function exportCommit(repo, sha) {
  const root = mkdtempSync(join(tmpdir(), 'seecode-drift-'));
  const tar = git(repo, ['archive', '--format=tar', sha], 'buffer');
  const x = spawnSync('tar', ['-x', '-C', root], { input: tar, maxBuffer: 1 << 30 });
  if (x.status !== 0) throw new Error(`tar: ${String(x.stderr).trim()}`);
  return root;
}

const words = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const nodeText = (n) => words([n.id, n.label, n.sub, n.tag].join(' '));
const lineCount = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

// SeeCode's scan lists a compose file's named volumes among its services.
function composeVolumes(path) {
  const names = new Set();
  let inVolumes = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\S/.test(line)) inVolumes = /^volumes:\s*$/.test(line);
    else if (inVolumes) {
      const m = /^ {2}([\w.-]+):/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

// The report for one exported tree. Pure apart from reading files under root and
// running SeeCode's own validate and scan, so fixtures can drive it directly.
export function driftOf({ root, specDir, ignore = [] }) {
  const specs = readdirSync(join(root, specDir)).filter((f) => f.endsWith('.json')).sort().map((file) => {
    const path = join(root, specDir, file);
    let spec = null;
    try { spec = JSON.parse(readFileSync(path, 'utf8')); } catch { /* reported by validate */ }
    const v = seecode(['validate', path], root);
    const codes = [...(v.problems || []), ...(v.warnings || [])].map((p) => p.code).filter(Boolean);
    return { name: file.replace(/\.json$/, ''), spec, render: { spec: file.replace(/\.json$/, ''), ok: v.ok === true, codes: [...new Set(codes)], ...(v.error ? { error: v.error } : {}) } };
  });

  const lines = new Map();
  const linesOf = (file) => {
    if (!lines.has(file)) {
      const p = join(root, file);
      lines.set(file, !file.split('/').includes('..') && existsSync(p) ? lineCount(readFileSync(p, 'utf8')) : null);
    }
    return lines.get(file);
  };
  const staleEvidence = [];
  const evidence = [];
  const nodes = [];
  for (const { name, spec } of specs) {
    for (const e of spec?.evidence || []) {
      evidence.push(e);
      const count = linesOf(String(e.file));
      if (count === null) staleEvidence.push({ spec: name, id: e.id, file: e.file, line: e.line, reason: 'missing-file' });
      else if (Number(e.line) > count) staleEvidence.push({ spec: name, id: e.id, file: e.file, line: e.line, reason: 'line-past-end', lines: count });
    }
    for (const n of spec?.nodes || []) nodes.push(n);
  }

  const unevidenced = specs.flatMap(({ name, spec }) => (spec?.nodes || [])
    .filter((n) => n.kind !== 'optional' && !(spec.evidence || []).some((e) => e.id === n.id))
    .map((n) => ({ spec: name, id: n.id, label: n.label })));

  const ignored = (s) => ignore.some((i) => s === i || s.startsWith(`${i}/`));
  const cites = (file) => evidence.some((e) => e.file === file);
  const named = (name) => nodes.some((n) => nodeText(n).includes(words(name)));
  const scan = seecode(['scan', root], root);
  const unmapped = scan.ok ? [] : [{ kind: 'scan-failed', name: scan.error || 'scan failed' }];
  for (const m of scan.modules || []) {
    if (ignored(m.dir)) continue;
    const mapped = evidence.some((e) => String(e.file).startsWith(`${m.dir}/`)) || nodes.some((n) => words(n.id) === words(m.dir) || words(n.label) === words(m.dir));
    if (!mapped) unmapped.push({ kind: 'module', name: m.dir, files: m.files });
  }
  for (const [tech, where] of Object.entries(scan.tech || {})) {
    if (ignored(tech) || named(tech) || cites(String(where).replace(/:\d+$/, ''))) continue;
    unmapped.push({ kind: 'tech', name: tech, at: where });
  }
  for (const i of scan.infra || []) {
    if (ignored(i.file)) continue;
    if (i.kind === 'compose') {
      const volumes = composeVolumes(join(root, i.file));
      for (const s of i.services || []) if (!volumes.has(s) && !ignored(s) && !named(s)) unmapped.push({ kind: 'infra', name: s, at: i.file });
    } else if (!cites(i.file)) {
      unmapped.push({ kind: 'infra', name: i.file, infraKind: i.kind });
    }
  }

  const render = specs.map((s) => s.render);
  const failed = render.filter((r) => !r.ok).length;
  const counts = { specs: render.length, renderErrors: failed, staleEvidence: staleEvidence.length, unmapped: unmapped.length, unevidenced: unevidenced.length };
  const parts = [
    failed && (failed === 1 ? '1 spec fails to render' : `${failed} specs fail to render`),
    staleEvidence.length && `${staleEvidence.length} stale evidence`,
    unmapped.length && `${unmapped.length} unmapped`,
    unevidenced.length && `${unevidenced.length} unevidenced`,
  ].filter(Boolean);
  const text = parts.length ? `${parts.join(', ')}.` : `Clean: ${render.length} specs match the code.`;
  return { render, staleEvidence, unmapped, unevidenced, matchRules: MATCH_RULES, ignore, summary: { ...counts, clean: parts.length === 0, text } };
}

export function driftReport(board, dataDir, now = Date.now()) {
  const { commit } = readState(dataDir, board.id);
  if (!commit) throw new Error(`board ${board.id} has no rendered commit yet`);
  const [sha, date] = git(board.repo, ['log', '-1', '--format=%H %cI', commit, '--', board.specDir]).trim().split(' ');
  const root = exportCommit(board.repo, commit);
  try {
    return { board: board.id, commit, generatedAt: new Date(now).toISOString(), lastSpecChange: sha ? { commit: sha, date } : null, ...driftOf({ root, specDir: board.specDir, ignore: board.driftIgnore }) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function writeReport(dataDir, id, report) {
  const p = join(dataDir, id, 'drift.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--board');
  const id = i > 0 ? process.argv[i + 1] : undefined;
  const boards = parseBoards(readFileSync(process.env.SEECODE_BOARDS || '/config/boards.json', 'utf8'));
  const board = boards.find((b) => b.id === id);
  if (!board) {
    console.error(`usage: drift.mjs --board <id> (one of: ${boards.map((b) => b.id).join(', ')})`);
    process.exit(2);
  }
  const dataDir = process.env.SEECODE_DATA || '/data';
  try {
    const report = driftReport(board, dataDir);
    writeReport(dataDir, board.id, report);
    console.log(JSON.stringify(report));
  } catch (e) {
    console.error(`drift ${board.id}: ${e.message}`);
    process.exit(1);
  }
}
