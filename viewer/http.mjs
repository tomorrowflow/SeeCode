// Serves each board's rendered map: /board/<id>/ is SeeCode's index with a
// status header, /board/<id>/<name>.html a diagram whose evidence entries link
// to the code on GitHub, /board/<id>/drift.json the latest drift report.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readState, servedDir, hasMap } from './boards.mjs';

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

function header(board, dataDir, state) {
  const sha = state.commit;
  const commit = board.github ? `<a href="https://github.com/${esc(board.github)}/commit/${esc(sha)}" target="_blank" rel="noopener"><code>${esc(sha.slice(0, 7))}</code></a>` : `<code>${esc(sha.slice(0, 7))}</code>`;
  const parts = [`<b>${esc(board.id)}</b>`, `${commit} rendered ${esc(when(state.renderedAt))}`, driftLine(dataDir, board.id), errorLine(state)].filter(Boolean);
  return `<div style="font:13px/1.5 system-ui,sans-serif;padding:10px 16px;border-bottom:1px solid var(--sc-rule,#ddd);display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--sc-muted,#555)"><a href="/">All boards</a>${parts.map((p) => `<span>${p}</span>`).join('')}</div>`;
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
    const type = name.split('.').pop();
    if (type !== 'html') return send(200, readFileSync(file), TYPES[type]);
    let html = readFileSync(file, 'utf8');
    if (name === 'index.html') html = injectAfterBody(html, header(board, dataDir, state));
    else if (board.github) html = injectBeforeBodyEnd(html, evidenceLinks(board.github, state.commit));
    return send(200, html);
  };
}
