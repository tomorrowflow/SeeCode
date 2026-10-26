// Serves each board's rendered map: /board/<id>/ is SeeCode's index with a
// status header and commit picker, /board/<id>/<name>.html a diagram whose
// evidence entries link to the code on GitHub, /board/<id>/at/<sha>/ the map at
// a past spec commit, /board/<id>/delta what changed between two commits, and
// /board/<id>/drift.json the latest drift report.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readState, servedDir, hasMap, specHistory, renderedAt, git } from './boards.mjs';
import { deltaReport } from './delta.mjs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FILE = /^[\w.-]+\.(html|json)$/;
const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8' };

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:40px 16px;color:#1d1d1f;background:#fbfaf7}main{max-width:720px;margin:0 auto}a{color:#2f54eb}code{font:13px ui-monospace,monospace}
@media (prefers-color-scheme:dark){body{color:#ecebe6;background:#16161a}a{color:#8aa4ff}}</style></head><body><main>${body}</main></body></html>`;

const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function errorLine(state) {
  const e = state.error;
  if (!e) return '';
  const at = e.commit ? ` at <code>${esc(e.commit.slice(0, 7))}</code>` : '';
  const specs = (e.problems || []).map((p) => `${esc(p.spec)}: ${esc(p.error || p.problems?.map((x) => x.code || x).join(', ') || 'failed')}`).join('; ');
  return `<span style="color:#c0392b">Last render failed${at}: ${esc(e.message)}${specs ? ` (${specs})` : ''}</span>`;
}

function driftLine(dataDir, id) {
  try {
    const d = JSON.parse(readFileSync(join(dataDir, id, 'drift.json'), 'utf8'));
    return d.summary?.text ? `<a href="drift.json">Drift: ${esc(d.summary.text)}</a>` : '';
  } catch { return ''; }
}

const commitLink = (board, sha) => (board.github
  ? `<a href="https://github.com/${esc(board.github)}/commit/${esc(sha)}" target="_blank" rel="noopener"><code>${esc(sha.slice(0, 7))}</code></a>`
  : `<code>${esc(sha.slice(0, 7))}</code>`);

// Lists the latest map and every past spec commit; picking one navigates to it.
function picker(board, history, at) {
  const base = `/board/${encodeURIComponent(board.id)}/`;
  const options = [`<option value="${base}"${at ? '' : ' selected'}>Latest map</option>`, ...history.map((c) => `<option value="${base}at/${c.commit}/"${c.commit === at ? ' selected' : ''}>${esc(c.date.slice(0, 10))} ${esc(c.commit.slice(0, 7))} ${esc(c.subject.slice(0, 60))}</option>`)];
  return `<select aria-label="Map version" onchange="location.href=this.value" style="font:inherit;max-width:22em">${options.join('')}</select>`;
}

function header(board, dataDir, state, at) {
  const history = specHistory(board);
  const parts = at
    ? [`<b>${esc(board.id)}</b>`, picker(board, history, at.commit), `<span style="color:#b26a00">Older map from ${esc(at.date.slice(0, 10))} (${commitLink(board, at.commit)}). <a href="/board/${encodeURIComponent(board.id)}/">Back to the latest</a></span>`, `<a href="/board/${encodeURIComponent(board.id)}/delta?to=${at.commit}">What changed here</a>`]
    : [`<b>${esc(board.id)}</b>`, picker(board, history, null), `${commitLink(board, state.commit)} rendered ${esc(when(state.renderedAt))}`, history.length ? '<a href="delta">What changed last</a>' : '', driftLine(dataDir, board.id), errorLine(state)];
  return `<div style="font:13px/1.5 system-ui,sans-serif;padding:10px 16px;border-bottom:1px solid var(--sc-rule,#ddd);display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;color:var(--sc-muted,#555)"><a href="/">All boards</a>${parts.filter(Boolean).map((p) => `<span>${p}</span>`).join('')}</div>`;
}

const SHA = /^[0-9a-f]{7,40}$/;

// The default range is the newest spec change up to the target commit.
function deltaRange(board, url, state) {
  const q = url.searchParams;
  for (const k of ['from', 'to']) if (q.has(k) && !SHA.test(q.get(k))) return null;
  const to = q.get('to') || state.commit;
  if (!to) return null;
  if (q.has('from')) return { from: q.get('from'), to };
  const newest = git(board.repo, ['log', '-1', '--format=%H %P', to, '--', board.specDir]).trim().split(' ');
  return { from: newest[1] || undefined, to };
}

const list = (items, fmt) => (items.length ? `<ul>${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '');

function deltaPage(board, d) {
  const range = `${d.from ? `<code>${esc(d.from.commit.slice(0, 7))}</code>` : 'the start'} to <code>${esc(d.to.commit.slice(0, 7))}</code>`;
  const commits = list(d.specCommits, (c) => `${commitLink(board, c.commit)} ${esc(c.date.slice(0, 10))} ${esc(c.subject)} · <a href="at/${c.commit}/">map</a>`);
  const specs = d.specs.map((s) => {
    if (s.status !== 'changed') return `<h2>${esc(s.spec)}: ${esc(s.status)}</h2>${s.status === 'added' ? `<p>${s.nodes} nodes, ${s.edges} edges.</p>` : ''}`;
    const n = s.nodes;
    const e = s.edges;
    const v = s.evidence;
    return `<h2>${esc(s.spec)}</h2>${[
      list(n.added, (x) => `node added: <b>${esc(x.label ?? x.id)}</b> <code>${esc(x.id)}</code>`),
      list(n.removed, (x) => `node removed: <b>${esc(x.label ?? x.id)}</b> <code>${esc(x.id)}</code>`),
      list(n.changed, (x) => `node <code>${esc(x.id)}</code>: ${Object.entries(x.fields).map(([f, [a, b]]) => `${esc(f)} “${esc(a ?? '')}” → “${esc(b ?? '')}”`).join(', ')}`),
      list(n.moved, (x) => `node <code>${esc(x.id)}</code> moved`),
      list(e.added, (x) => `edge added: <code>${esc(x.edge)}</code> ${esc(x.label ?? '')}`),
      list(e.removed, (x) => `edge removed: <code>${esc(x.edge)}</code> ${esc(x.label ?? '')}`),
      list(e.changed, (x) => `edge <code>${esc(x.edge)}</code>: “${esc(x.label[0] ?? '')}” → “${esc(x.label[1] ?? '')}”`),
      list([...v.added.map((x) => ['added', x]), ...v.removed.map((x) => ['removed', x]), ...v.moved.map((x) => ['moved', x])], ([k, x]) => `evidence ${k}: <code>${esc(x.id)}</code> <code>${esc(x.file)}:${esc(Array.isArray(x.line) ? x.line.join('→') : x.line)}</code>`),
    ].join('')}`;
  }).join('');
  return page(`${board.id} delta`, `<p><a href="./">Back to the map</a> · <a href="delta.json?${d.from ? `from=${d.from.commit}&amp;` : ''}to=${d.to.commit}">JSON</a></p><h1>${esc(board.id)}: what changed</h1><p>From ${range}: ${esc(d.summary.text)}</p>${commits}${specs}`);
}

// Turns each "file:line" in the Sources list into a link to that line at the served commit.
const evidenceLinks = (github, sha) => `<script>(()=>{const base=${JSON.stringify(`https://github.com/${github}/blob/${sha}/`)};
for(const c of document.querySelectorAll('.sc-evidence code')){const m=/^(.*?)(?::(\\d+))?$/.exec(c.textContent);const a=document.createElement('a');
a.href=base+m[1].split('/').map(encodeURIComponent).join('/')+(m[2]?'#L'+m[2]:'');a.target='_blank';a.rel='noopener';c.replaceWith(a);a.append(c);}})();</script>`;

const injectAfterBody = (html, s) => html.replace(/<body[^>]*>/, (m) => m + s);
const injectBeforeBodyEnd = (html, s) => (html.includes('</body>') ? html.replace('</body>', `${s}</body>`) : html + s);

export function createHandler({ boards, dataDir, allowHosts }) {
  const byId = new Map(boards.map((b) => [b.id, b]));
  return (req, res) => {
    const send = (status, body, type = TYPES.html, extra = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    if (!allowHosts.includes(hostname)) return send(403, 'Forbidden host\n', 'text/plain; charset=utf-8');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method not allowed\n', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' });

    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/') {
      const rows = boards.map((b) => {
        const s = readState(dataDir, b.id);
        return `<li><a href="/board/${esc(b.id)}/">${esc(b.id)}</a> ${s.commit ? `<code>${esc(s.commit.slice(0, 7))}</code>` : 'no map yet'}</li>`;
      }).join('');
      return send(200, page('Architecture maps', `<h1>Architecture maps</h1><ul>${rows}</ul>`));
    }
    const m = /^\/board\/([^/]+)(\/(.*))?$/.exec(path);
    const board = m && byId.get(decodeURIComponent(m[1]));
    if (!board) return send(404, page('Not found', '<p>No such board. <a href="/">All boards</a></p>'));
    if (!m[2]) return send(301, '', TYPES.html, { location: `/board/${encodeURIComponent(board.id)}/` });

    const name = m[3] || 'index.html';
    if (name === 'delta' || name === 'delta.json') {
      const range = deltaRange(board, new URL(req.url, 'http://x'), readState(dataDir, board.id));
      if (!range) return send(400, page('Bad range', '<p>from and to must be commit shas.</p>'));
      let d;
      try { d = deltaReport(board, range); } catch { return send(404, page('Not found', '<p>Unknown commit.</p>')); }
      return name === 'delta.json' ? send(200, `${JSON.stringify(d, null, 2)}\n`, TYPES.json) : send(200, deltaPage(board, d));
    }
    const at = /^at\/([0-9a-f]{40})\/(.*)$/.exec(name);
    if (at) {
      const dir = renderedAt(board, dataDir, at[1]);
      const file = at[2] || 'index.html';
      if (!dir || !FILE.test(file) || !existsSync(join(dir, file))) return send(404, page('Not found', '<p>No map at that commit. <a href="/">All boards</a></p>'));
      return sendMap(file, join(dir, file), at[1], () => header(board, dataDir, {}, specHistory(board).find((c) => c.commit === at[1])));
    }
    if (name === 'drift.json') {
      const p = join(dataDir, board.id, 'drift.json');
      return existsSync(p) ? send(200, readFileSync(p), TYPES.json) : send(404, '{"error":"no drift report yet"}\n', TYPES.json);
    }
    const state = readState(dataDir, board.id);
    if (!hasMap(board, dataDir, state)) {
      const why = state.error ? `<p>${errorLine(state)}</p>` : '<p>Waiting for the first render.</p>';
      return send(name === 'index.html' ? 200 : 404, page(`${board.id} map`, `<h1>${esc(board.id)}</h1><p>No map yet.</p>${why}<p><a href="/">All boards</a></p>`));
    }
    if (!FILE.test(name)) return send(404, page('Not found', '<p>Not found.</p>'));
    const file = join(servedDir(board, dataDir, state), name);
    if (!existsSync(file)) return send(404, page('Not found', '<p>Not found.</p>'));
    return sendMap(name, file, state.commit, () => header(board, dataDir, state, null));

    function sendMap(fileName, file, sha, makeHeader) {
      const type = fileName.split('.').pop();
      if (type !== 'html') return send(200, readFileSync(file), TYPES[type]);
      let html = readFileSync(file, 'utf8');
      if (fileName === 'index.html') html = injectAfterBody(html, makeHeader());
      else if (board.github) html = injectBeforeBodyEnd(html, evidenceLinks(board.github, sha));
      return send(200, html);
    }
  };
}
