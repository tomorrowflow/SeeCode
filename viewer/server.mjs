#!/usr/bin/env node
// Architecture viewer: renders each configured board's SeeCode specs from its
// clone and serves them. Configuration comes from the environment:
//   SEECODE_BOARDS       boards.json path (default /config/boards.json)
//   SEECODE_DATA         render and state directory (default /data)
//   SEECODE_RESCAN       seconds between ref checks (default 120)
//   SEECODE_ALLOW_HOSTS  comma-separated Host names to answer (default localhost)
//   PORT, SEECODE_BIND   listen address (default 0.0.0.0:17318)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseBoards, refreshBoard } from './boards.mjs';
import { createHandler } from './http.mjs';

const env = process.env;
const boards = parseBoards(readFileSync(env.SEECODE_BOARDS || '/config/boards.json', 'utf8'));
const dataDir = env.SEECODE_DATA || '/data';
const rescanMs = Math.max(10, Number(env.SEECODE_RESCAN) || 120) * 1000;
const allowHosts = (env.SEECODE_ALLOW_HOSTS || 'localhost').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
const port = Number(env.PORT) || 17318;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
const last = new Map();

function tick() {
  for (const board of boards) {
    let state;
    try { state = refreshBoard(board, dataDir); } catch (e) { log(`${board.id}: refresh crashed: ${e.message}`); continue; }
    const line = `${board.id}: serving ${state.commit?.slice(0, 7) ?? 'nothing'}${state.error ? `; ${state.error.message}` : ''}`;
    if (last.get(board.id) !== line) log(line);
    last.set(board.id, line);
  }
}

createServer(createHandler({ boards, dataDir, allowHosts })).listen(port, env.SEECODE_BIND || '0.0.0.0', () => {
  log(`listening on ${port} for ${allowHosts.join(', ')}; ${boards.length} board(s), rescan ${rescanMs / 1000}s`);
  tick();
  setInterval(tick, rescanMs);
});
