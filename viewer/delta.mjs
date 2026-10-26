#!/usr/bin/env node
// Architecture delta for one board: what changed in its specs between two
// commits, as a structural diff. Deterministic, no model calls.
//   node viewer/delta.mjs --board <id> --since <ISO date> --until <ISO date>
//   node viewer/delta.mjs --board <id> --from <rev> --to <rev>
// Prints the delta as JSON. A date window compares the ref's last commits
// before each bound, so it covers the spec commits made inside the window.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { git, parseBoards } from './boards.mjs';

const NODE_FIELDS = ['label', 'sub', 'tag', 'kind'];
const byKey = (items, key) => new Map(items.map((x) => [key(x), x]));
const edgeKey = (e) => `${e[0]}>${e[1]}`;
const evidenceKey = (e) => `${e.id}|${e.file}`;

function diffSpec(a, b) {
  const nodes = { added: [], removed: [], changed: [], moved: [] };
  const an = byKey(a.nodes || [], (n) => n.id);
  const bn = byKey(b.nodes || [], (n) => n.id);
  for (const [id, n] of bn) {
    const old = an.get(id);
    if (!old) { nodes.added.push({ id, label: n.label }); continue; }
    const fields = Object.fromEntries(NODE_FIELDS.filter((f) => old[f] !== n[f]).map((f) => [f, [old[f] ?? null, n[f] ?? null]]));
    if (Object.keys(fields).length) nodes.changed.push({ id, fields });
    if (old.row !== n.row || old.col !== n.col) nodes.moved.push({ id, from: [old.row, old.col], to: [n.row, n.col] });
  }
  for (const [id, n] of an) if (!bn.has(id)) nodes.removed.push({ id, label: n.label });

  const edges = { added: [], removed: [], changed: [] };
  const ae = byKey(a.edges || [], edgeKey);
  const be = byKey(b.edges || [], edgeKey);
  for (const [k, e] of be) {
    const old = ae.get(k);
    if (!old) edges.added.push({ edge: k, label: e[2] ?? null });
    else if ((old[2] ?? null) !== (e[2] ?? null)) edges.changed.push({ edge: k, label: [old[2] ?? null, e[2] ?? null] });
  }
  for (const [k, e] of ae) if (!be.has(k)) edges.removed.push({ edge: k, label: e[2] ?? null });

  const evidence = { added: [], removed: [], moved: [] };
  const av = byKey(a.evidence || [], evidenceKey);
  const bv = byKey(b.evidence || [], evidenceKey);
  for (const [k, e] of bv) {
    const old = av.get(k);
    if (!old) evidence.added.push({ id: e.id, file: e.file, line: e.line });
    else if (old.line !== e.line) evidence.moved.push({ id: e.id, file: e.file, line: [old.line, e.line] });
  }
  for (const [k, e] of av) if (!bv.has(k)) evidence.removed.push({ id: e.id, file: e.file, line: e.line });
  return { nodes, edges, evidence };
}

const size = (d) => Object.values(d).reduce((n, group) => n + Object.values(group).reduce((m, list) => m + list.length, 0), 0);

// from and to map spec name to its parsed spec. Pure.
export function diffSpecSets(from, to) {
  const specs = [];
  for (const name of [...new Set([...from.keys(), ...to.keys()])].sort()) {
    const a = from.get(name);
    const b = to.get(name);
    if (!a) specs.push({ spec: name, status: 'added', nodes: (b.nodes || []).length, edges: (b.edges || []).length });
    else if (!b) specs.push({ spec: name, status: 'removed' });
    else {
      const d = diffSpec(a, b);
      if (size(d)) specs.push({ spec: name, status: 'changed', ...d });
    }
  }
  const changed = specs.filter((s) => s.status === 'changed');
  const sum = (pick) => changed.reduce((n, s) => n + pick(s), 0);
  const counts = {
    specsAdded: specs.filter((s) => s.status === 'added').length,
    specsRemoved: specs.filter((s) => s.status === 'removed').length,
    specsChanged: changed.length,
    nodesAdded: sum((s) => s.nodes.added.length),
    nodesRemoved: sum((s) => s.nodes.removed.length),
    nodesChanged: sum((s) => s.nodes.changed.length),
    edgesAdded: sum((s) => s.edges.added.length),
    edgesRemoved: sum((s) => s.edges.removed.length),
    evidenceChanged: sum((s) => s.evidence.added.length + s.evidence.removed.length + s.evidence.moved.length),
  };
  const parts = [
    counts.specsAdded && `${counts.specsAdded} spec${counts.specsAdded === 1 ? '' : 's'} added (${specs.filter((s) => s.status === 'added').map((s) => s.spec).join(', ')})`,
    counts.specsRemoved && `${counts.specsRemoved} removed`,
    ...changed.map((s) => {
      const bits = [
        s.nodes.added.length && `+${s.nodes.added.length} node${s.nodes.added.length === 1 ? '' : 's'}`,
        s.nodes.removed.length && `-${s.nodes.removed.length} node${s.nodes.removed.length === 1 ? '' : 's'}`,
        s.nodes.changed.length && `${s.nodes.changed.length} relabelled`,
        s.edges.added.length && `+${s.edges.added.length} edge${s.edges.added.length === 1 ? '' : 's'}`,
        s.edges.removed.length && `-${s.edges.removed.length} edge${s.edges.removed.length === 1 ? '' : 's'}`,
      ].filter(Boolean);
      return `${s.spec}: ${bits.length ? bits.join(', ') : 'evidence and layout only'}`;
    }),
  ].filter(Boolean);
  return { specs, summary: { ...counts, unchanged: specs.length === 0, text: parts.length ? `${parts.join('; ')}.` : 'No spec changes.' } };
}

function specsAt(board, sha) {
  const specs = new Map();
  if (!sha) return specs;
  const files = git(board.repo, ['ls-tree', '--name-only', sha, `${board.specDir}/`]).split('\n').filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try { specs.set(file.slice(board.specDir.length + 1, -5), JSON.parse(git(board.repo, ['show', `${sha}:${file}`]))); } catch { /* not a spec */ }
  }
  return specs;
}

const resolve = (board, rev) => git(board.repo, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
const lastBefore = (board, date) => git(board.repo, ['rev-list', '-1', `--before=${date}`, board.ref]).trim() || null;
const commitInfo = (board, sha) => {
  if (!sha) return null;
  const [date, ...subject] = git(board.repo, ['show', '-s', '--format=%cI%x09%s', sha]).trim().split('\t');
  return { commit: sha, date, subject: subject.join('\t') };
};

export function deltaReport(board, { from, to, since, until }, now = Date.now()) {
  const window = since && until ? { since, until } : null;
  const fromSha = window ? lastBefore(board, since) : from ? resolve(board, from) : null;
  const toSha = window ? lastBefore(board, until) : resolve(board, to ?? board.ref);
  const range = fromSha && toSha ? `${fromSha}..${toSha}` : toSha;
  const specCommits = toSha ? git(board.repo, ['log', '--format=%H%x09%cI%x09%s', range, '--', board.specDir]).split('\n').filter(Boolean).map((l) => {
    const [commit, date, ...subject] = l.split('\t');
    return { commit, date, subject: subject.join('\t') };
  }) : [];
  return {
    board: board.id,
    generatedAt: new Date(now).toISOString(),
    ...(window || {}),
    from: commitInfo(board, fromSha),
    to: commitInfo(board, toSha),
    specCommits,
    ...diffSpecSets(specsAt(board, fromSha), specsAt(board, toSha)),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const boards = parseBoards(readFileSync(process.env.SEECODE_BOARDS || '/config/boards.json', 'utf8'));
  const board = boards.find((b) => b.id === arg('board'));
  const opts = { from: arg('from'), to: arg('to'), since: arg('since'), until: arg('until') };
  if (!board || Boolean(opts.since) !== Boolean(opts.until)) {
    console.error(`usage: delta.mjs --board <id> (--since <date> --until <date> | [--from <rev>] [--to <rev>]); boards: ${boards.map((b) => b.id).join(', ')}`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(deltaReport(board, opts)));
  } catch (e) {
    console.error(`delta ${board.id}: ${e.message}`);
    process.exit(1);
  }
}
