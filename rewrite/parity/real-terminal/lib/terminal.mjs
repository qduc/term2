// A real terminal for one CLI: node-pty runs the program, its bytes stream over SSE into xterm.js in headless
// Chromium, and everything a user would see is read back from xterm.js (buffer text, rendered pixels).
//
// Path: CLI <-> pty (node-pty) <-> this process <-> SSE / POST <-> xterm.js (DOM renderer) in Chromium.
// Key-to-paint timing is measured entirely on the page clock: the page timestamps the key, posts it to the pty,
// and stops the clock at the first xterm.js render whose screen satisfies the key's predicate.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const pty = require('@lydell/node-pty');
const { chromium } = require('playwright');

export const TRANSPORT = 'node-pty bridge (no sshd in this environment) -> SSE -> xterm.js DOM renderer, headless Chromium';
export const FONT = { family: "'DejaVu Sans Mono', monospace", size: 14 };

const xtermJs = fs.readFileSync(path.join(repo, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');
const xtermCss = fs.readFileSync(path.join(repo, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8');
const pageHtml = fs.readFileSync(path.join(here, 'page.html'), 'utf8');

export function xtermVersion() {
  return JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/@xterm/xterm/package.json'), 'utf8')).version;
}

/** One Chromium and one local bridge server shared by every terminal of a run. */
export async function startStage() {
  const terminals = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const [, kind, id] = url.pathname.split('/');
    if (kind === '' || kind === 'page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(pageHtml.replace('/*XTERM_CSS*/', xtermCss).replace('/*XTERM_JS*/', () => xtermJs));
      return;
    }
    const term = terminals.get(id);
    if (!term) {
      res.writeHead(404).end();
      return;
    }
    if (kind === 'out') {
      req.socket.setNoDelay(true);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': open\n\n');
      term.attach(res);
      req.on('close', () => term.detach(res));
      return;
    }
    if (kind === 'in' && req.method === 'POST') {
      req.socket.setNoDelay(true);
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        term.input(JSON.parse(body).data);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    args: ['--disable-frame-rate-limit', '--disable-gpu-vsync', '--font-render-hinting=none'],
  });
  return {
    origin,
    browser,
    chromiumVersion: browser.version(),
    terminals,
    async close() {
      for (const term of terminals.values()) term.dispose();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let nextId = 0;

/**
 * Start `command args` in a pty of cols x rows and attach it to a fresh xterm.js page.
 * Returns the handle the harness drives.
 */
export async function openTerminal(stage, { command, args = [], env, cwd, cols, rows, label = 'term' }) {
  const id = `${label}-${++nextId}`;
  const listeners = new Set();
  const backlog = [];
  let bytes = 0;
  let lastOutputAt = Date.now();
  let exited = null;
  let resolveExit;
  const exit = new Promise((resolve) => (resolveExit = resolve));

  const child = pty.spawn(command, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const rawLog = process.env.RT_RAW_LOG ? `${process.env.RT_RAW_LOG}.${label}.${child.pid}` : null;
  child.onData((data) => {
    if (rawLog) fs.appendFileSync(rawLog, data);
    bytes += Buffer.byteLength(data, 'utf8');
    lastOutputAt = Date.now();
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    if (listeners.size === 0) backlog.push(frame);
    for (const res of listeners) res.write(frame);
  });
  child.onExit((event) => {
    exited = event;
    resolveExit(event);
  });

  const handle = {
    id,
    label,
    pid: child.pid,
    cols,
    rows,
    attach(res) {
      listeners.add(res);
      for (const frame of backlog.splice(0)) res.write(frame);
    },
    detach(res) {
      listeners.delete(res);
    },
    input(data) {
      if (rawLog) fs.appendFileSync(rawLog, `\n<<<INPUT ${JSON.stringify(data)}>>>\n`);
      if (!exited) child.write(data);
    },
    dispose() {
      try {
        if (!exited) child.kill('SIGKILL');
      } catch {
        // already gone
      }
      void page.close().catch(() => {});
    },
  };
  stage.terminals.set(id, handle);

  const page = await stage.browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(`${stage.origin}/page`);
  await page.evaluate(
    ({ id, cols, rows, font }) => window.boot(id, cols, rows, font),
    { id, cols, rows, font: FONT },
  );

  Object.defineProperties(handle, {
    exited: { get: () => exited },
    bytes: { get: () => bytes },
    lastOutputAt: { get: () => lastOutputAt },
  });
  Object.assign(handle, {
    page,
    exit,
    /** Write straight into the pty (walk and setup; not timed). */
    write(data) {
      handle.input(data);
    },
    /** Visible rows of the xterm.js viewport, right-trimmed. */
    async screen() {
      return page.evaluate(() => window.screenLines());
    },
    async screenText() {
      return (await handle.screen()).join('\n');
    },
    /** Wait until the xterm.js screen satisfies `test` (RegExp or string, or function source over `lines`). */
    async waitFor(test, timeoutMs = 30_000) {
      const source = predicateSource(test);
      const ok = await page.evaluate(({ source, timeoutMs }) => window.waitScreen(source, timeoutMs), {
        source,
        timeoutMs,
      });
      if (!ok) {
        const text = await handle.screenText();
        throw new Error(`[${label}] timed out waiting for ${String(test)}\n--- screen ---\n${text}`);
      }
    },
    /** Resolve once no pty output arrived for quietMs (or after maxMs). */
    async quiet(quietMs = 250, maxMs = 5_000) {
      const started = Date.now();
      while (Date.now() - started < maxMs) {
        if (Date.now() - lastOutputAt >= quietMs) break;
        await sleep(20);
      }
      // Let xterm.js parse and render whatever arrived.
      await page.evaluate(() => window.flush());
    },
    /**
     * Time one keystroke on the page clock: injection -> first render satisfying `test`.
     * `base` (optional, same forms as `test`) is evaluated on the page at injection; `test` sees it as `base`.
     * Returns { ms, parseMs, ok }.
     */
    async measureKey(data, test, timeoutMs = 5_000, base = null) {
      return page.evaluate(
        ({ data, source, timeoutMs, baseSource }) => window.measureKey(data, source, timeoutMs, baseSource),
        { data, source: predicateSource(test), timeoutMs, baseSource: base ? predicateSource(base) : null },
      );
    },
    async resize(newCols, newRows) {
      child.resize(newCols, newRows);
      handle.cols = newCols;
      handle.rows = newRows;
      await page.evaluate(({ c, r }) => window.resizeTerm(c, r), { c: newCols, r: newRows });
    },
    /** Rectangles (in px, relative to the screen element) of cells matching each mask regex. */
    async screenshot(file, masks = []) {
      await page.evaluate(() => window.flush());
      const rects = await page.evaluate((masks) => window.maskRects(masks), masks.map((m) => [m.source, m.flags]));
      await page.evaluate((rects) => window.paintMasks(rects), rects);
      const element = await page.$('#screen');
      await element.screenshot({ path: file });
      await page.evaluate(() => window.paintMasks([]));
      return rects;
    },
  });
  return handle;
}

function predicateSource(test) {
  if (test instanceof RegExp) return `return new RegExp(${JSON.stringify(test.source)}, ${JSON.stringify(test.flags)}).test(lines.join('\\n'));`;
  if (typeof test === 'string' && test.startsWith('fn:')) return test.slice(3);
  if (typeof test === 'string') return `return lines.join('\\n').includes(${JSON.stringify(test)});`;
  if (typeof test === 'function') return `return (${test.toString()})(lines);`;
  throw new Error(`unsupported predicate ${test}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** utime+stime (ms) of pid and all its descendants, from /proc. */
export function treeCpuMs(rootPid) {
  const ticks = 100; // USER_HZ on Linux
  const stats = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      stats.set(Number(entry), { ppid: Number(fields[1]), cpu: Number(fields[11]) + Number(fields[12]) });
    } catch {
      // process exited while scanning
    }
  }
  let total = 0;
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const stat = stats.get(pid);
    if (stat) total += stat.cpu;
    for (const [child, s] of stats) if (s.ppid === pid) queue.push(child);
  }
  return (total * 1000) / ticks;
}

/** Harness floor: key-to-paint for raw pty echo (`cat`) through the same pty -> SSE -> xterm.js path. */
export async function calibrate(stage, keys = 40) {
  const term = await openTerminal(stage, { command: '/bin/cat', args: [], env: { PATH: process.env.PATH }, cwd: '/', cols: 100, rows: 34, label: 'cat' });
  try {
    await sleep(300);
    let typed = '';
    const ms = [];
    for (let i = 0; i < keys; i++) {
      typed += 'abcdefghij'[i % 10];
      const result = await term.measureKey(typed.at(-1), typed);
      if (result.ok) ms.push(result.ms);
      await sleep(40);
    }
    ms.sort((a, b) => a - b);
    return { p50: ms[Math.ceil(ms.length / 2) - 1], max: ms.at(-1), n: ms.length };
  } finally {
    term.dispose();
  }
}
