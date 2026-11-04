#!/usr/bin/env node
// Two live terminals for the soak (SOAK-BRIEF.md): both CLIs side by side in real xterm.js terminals, driven
// by a context-free agent through this small command line. Terminals are labelled A and B; which CLI is which
// is chosen at random and written only to <state>/mapping.json, which the agent is told not to read.
//
//   node rewrite/parity/real-terminal/soak.mjs serve --state <dir> [--store <dir>] [--cols 100 --rows 34]
//   node rewrite/parity/real-terminal/soak.mjs type   <A|B|both> "<text with {keys}>"   type like a person
//   node rewrite/parity/real-terminal/soak.mjs screen <A|B>                            print the visible screen
//   node rewrite/parity/real-terminal/soak.mjs shot   <A|B|both>                       PNG path(s) of the screen
//   node rewrite/parity/real-terminal/soak.mjs resize <cols> <rows>                    resize both terminals
//   node rewrite/parity/real-terminal/soak.mjs restart <A|B|both>                      start the program again
//   node rewrite/parity/real-terminal/soak.mjs stop
//
// Keys inside text: {enter} {esc} {tab} {shift+tab} {backspace} {up} {down} {left} {right} {pgup} {pgdn}
// {ctrl+c} {ctrl+o} {ctrl+t} {ctrl+g} {alt+enter} {wait:500}
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sleep } from './lib/terminal.mjs';

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    state: { type: 'string', default: process.env.SOAK_STATE ?? path.join(process.cwd(), '.soak') },
    store: { type: 'string' },
    cols: { type: 'string', default: '100' },
    rows: { type: 'string', default: '34' },
  },
});
const state = path.resolve(values.state);

const KEYS = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
  'ctrl+c': '\x03',
  'ctrl+o': '\x0f',
  'ctrl+t': '\x14',
  'ctrl+g': '\x07',
  'alt+enter': '\x1b\r',
};

async function serve() {
  const { startStage } = await import('./lib/terminal.mjs');
  const { startCli, resolveStore } = await import('./lib/session.mjs');
  fs.mkdirSync(path.join(state, 'shots'), { recursive: true });
  const store = resolveStore(values.store);
  const scratch = fs.mkdtempSync(path.join(state, 'run-'));
  const stage = await startStage();
  const cols = Number(values.cols);
  const rows = Number(values.rows);
  const flip = crypto.randomInt(2) === 1;
  const mapping = flip ? { A: 'next', B: 'legacy' } : { A: 'legacy', B: 'next' };
  fs.writeFileSync(path.join(state, 'mapping.json'), JSON.stringify(mapping));
  const sessions = {};
  const start = async (label) => {
    const which = mapping[label];
    sessions[label] = await startCli(stage, { which, scratch, cols, rows, store: store[which], workspace: store.workspace ?? undefined });
    await sessions[label].ready(5 * 60_000).catch(() => {});
  };
  await Promise.all([start('A'), start('B')]);
  let shot = 0;
  const targets = (who) => (who === 'both' ? ['A', 'B'] : [String(who).toUpperCase()]);

  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    await new Promise((resolve) => req.on('end', resolve));
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      const { op, who, text, cols: c, rows: r } = JSON.parse(body || '{}');
      if (op === 'type') {
        const tokens = String(text).split(/(\{[a-z+:0-9]+\})/).filter(Boolean);
        for (const token of tokens) {
          const key = token.match(/^\{([a-z+:0-9]+)\}$/)?.[1];
          if (key?.startsWith('wait:')) {
            await sleep(Number(key.slice(5)));
            continue;
          }
          const chunks = key && KEYS[key] ? [KEYS[key]] : [...token];
          for (const chunk of chunks) {
            for (const label of targets(who)) sessions[label]?.term.write(chunk);
            await sleep(key ? 60 : 15);
          }
        }
        await sleep(400);
        return reply(200, { ok: true });
      }
      if (op === 'screen') {
        const s = sessions[targets(who)[0]];
        return reply(200, { screen: (await s.term.screen()).join('\n'), exited: Boolean(s.term.exited) });
      }
      if (op === 'shot') {
        const files = [];
        for (const label of targets(who)) {
          const file = path.join(state, 'shots', `${String(++shot).padStart(4, '0')}-${label}.png`);
          await sessions[label].term.screenshot(file, []);
          files.push(file);
        }
        return reply(200, { files });
      }
      if (op === 'resize') {
        for (const label of ['A', 'B']) await sessions[label].term.resize(Number(c), Number(r));
        await sleep(500);
        return reply(200, { ok: true });
      }
      if (op === 'restart') {
        for (const label of targets(who)) {
          await sessions[label].close();
          await start(label);
        }
        return reply(200, { ok: true });
      }
      if (op === 'stop') {
        reply(200, { ok: true });
        for (const s of Object.values(sessions)) await s.close().catch(() => {});
        await stage.close();
        fs.rmSync(scratch, { recursive: true, force: true });
        fs.rmSync(path.join(state, 'port'), { force: true });
        process.exit(0);
      }
      reply(400, { error: `unknown op ${op}` });
    } catch (error) {
      reply(500, { error: String(error?.stack ?? error) });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(path.join(state, 'port'), String(server.address().port));
    // The agent's only command: <state>/t <command> [args].
    const self = new URL(import.meta.url).pathname;
    fs.writeFileSync(path.join(state, 't'), `#!/bin/sh\nexec "${process.execPath}" "${self}" "$@" --state "${state}"\n`, { mode: 0o755 });
    console.log(`soak terminals ready (A and B); the agent's command is ${path.join(state, 't')}`);
  });
}

async function call(payload) {
  const portFile = path.join(state, 'port');
  if (!fs.existsSync(portFile)) throw new Error(`no soak server: run "soak.mjs serve --state ${state}" first`);
  const port = fs.readFileSync(portFile, 'utf8').trim();
  const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify(payload) });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

if (command === 'serve') await serve();
else if (command === 'type') await call({ op: 'type', who: positionals[0], text: positionals.slice(1).join(' ') });
else if (command === 'screen') {
  const { screen, exited } = await call({ op: 'screen', who: positionals[0] });
  console.log(screen.replace(/\s+$/, ''));
  if (exited) console.log('[the program in this terminal has exited]');
} else if (command === 'shot') console.log((await call({ op: 'shot', who: positionals[0] ?? 'both' })).files.join('\n'));
else if (command === 'resize') await call({ op: 'resize', cols: positionals[0], rows: positionals[1] });
else if (command === 'restart') await call({ op: 'restart', who: positionals[0] ?? 'both' });
else if (command === 'stop') await call({ op: 'stop' });
else {
  console.error('commands: serve | type <A|B|both> <text> | screen <A|B> | shot <A|B|both> | resize <c> <r> | restart <A|B|both> | stop');
  process.exit(2);
}
