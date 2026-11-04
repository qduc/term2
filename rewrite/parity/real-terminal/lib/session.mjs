// Start one CLI in a real terminal with its own home, store copy and fake provider, and the small helpers the
// latency run, the screenshot walk and the soak share.
import fs from 'node:fs';
import path from 'node:path';
import { openTerminal, sleep } from './terminal.mjs';
import { startProvider, lastUserText, afterToolResult, isCompactionRequest } from './provider.mjs';
import { prepareHome, makeRoot, CLIS } from './env.mjs';

/** Words streamed by the fake model while "a reply streams"; predicates skip rows made of them. */
export const STREAM_WORD = 'sw';
export const STREAM_ROW = /\bsw\d+\b/;

/**
 * The scripted model both CLIs talk to. Deterministic per prompt so both CLIs get identical replies.
 *   "stream ..."            a long streamed reply (STREAM_WORD tokens, ~25 s)
 *   "list the files ..."    shell `ls` (auto-approved read), then a short summary
 *   "create a file ..."     shell `touch` (needs approval), then a short summary
 *   "show markdown ..."     a markdown reply (heading, list, code block)
 *   anything else           a short plain reply
 */
export function scriptedModel({ streamDeltas = 2500, streamEveryMs = 10 } = {}) {
  return (body, n, raw) => {
    if (isCompactionRequest(raw)) return { text: 'Summary: the user explored the demo project and asked questions.' };
    if (afterToolResult(body)) return { text: 'Done. The command finished; the workspace has README.md, notes.txt and src/.' };
    const prompt = lastUserText(body).toLowerCase();
    if (prompt.includes('stream')) {
      return {
        deltas: Array.from({ length: streamDeltas }, (_, i) => `${i % 12 === 11 ? '\n' : ''}${STREAM_WORD}${i} `),
        everyMs: streamEveryMs,
      };
    }
    if (prompt.includes('list the files')) return { toolCalls: [{ name: 'shell', arguments: { command: 'ls' } }] };
    if (prompt.includes('create a file')) {
      return { toolCalls: [{ name: 'shell', arguments: { command: 'touch created-by-walk.txt' } }] };
    }
    if (prompt.includes('markdown')) {
      return {
        text: '## Plan\n\n1. Read `notes.txt`\n2. Summarise it\n\n```js\nexport function main() {\n  return 42;\n}\n```\n\nThat is **all**.',
      };
    }
    return { text: `Sure. This is a short answer to: ${prompt.slice(0, 40)}` };
  };
}

/**
 * Resolve the store layout: a generated store (`<dir>/conversations` + `<dir>/conversations-next`) or a real
 * term2 data dir with the same two names. Returns the per-CLI source directory (or null) and a workspace.
 */
export function resolveStore(store) {
  if (!store) return { legacy: null, next: null, workspace: null };
  const dir = path.resolve(store);
  const pick = (name) => (fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null);
  const legacy = pick('conversations');
  const next = pick('conversations-next');
  if (!legacy && !next) throw new Error(`--store ${dir} has neither conversations/ nor conversations-next/`);
  return { legacy, next, workspace: pick('workspace') };
}

/**
 * `home` (optional) reuses a previous session's home and store copy (its settings are re-pointed at this
 * session's provider); `keep` leaves the home on disk after close() so a later session can reuse it.
 */
export async function startCli(stage, { which, scratch, cols, rows, store, workspace, model, settings, home: reuse, keep = false }) {
  const provider = await startProvider(model ?? scriptedModel());
  const home = reuse
    ? prepareHome({ root: reuse.root, baseUrl: provider.baseUrl, store: null, settings, reuse: true })
    : prepareHome({ root: makeRoot(scratch, which), baseUrl: provider.baseUrl, store, settings });
  const cwd = workspace ?? home.workspace;
  const term = await openTerminal(stage, {
    command: process.execPath,
    args: [CLIS[which].cli],
    env: home.env,
    cwd,
    cols,
    rows,
    label: which,
  });
  const session = {
    which,
    term,
    provider,
    home,
    cwd,
    async ready(timeoutMs = 60_000) {
      await term.waitFor(`fn:${COMPOSER_READY}`, timeoutMs);
      await term.quiet(400, 10_000);
    },
    async close() {
      if (!term.exited) {
        term.write('\x03');
        await sleep(150);
        term.write('\x03');
        await Promise.race([term.exit, sleep(5_000)]);
      }
      term.dispose();
      await provider.close();
      if (!keep) fs.rmSync(home.root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return session;
}

/** Type like a person: one key per write. A whole string in one write is a paste to both CLIs. */
export async function typeText(term, text, gapMs = 12) {
  for (const ch of text) {
    term.write(ch);
    await sleep(gapMs);
  }
}

/**
 * Predicate prelude shared by every screen test. `lines` is the visible xterm.js viewport.
 *   sep       index of the last composer separator row (a row of ─)
 *   composer  the input row: the last ❯ row below it (legacy lists queued steers between the two)
 *   tail()    rows after the last streamed row, minus the status row and elapsed-time/spinner rows: the part of
 *             the screen a key can change while a reply streams above it
 */
export const PRELUDE = `
  let sep = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/^\\s*─{20,}\\s*$/.test(lines[i])) { sep = i; break; }
  let composer = sep >= 0 ? (lines[sep + 1] ?? '') : '';
  for (let i = lines.length - 1; i > sep && sep >= 0; i--) if (/^\\s*❯/.test(lines[i])) { composer = lines[i]; break; }
  const tail = () => {
    let start = 0;
    for (let i = 0; i < lines.length; i++) if (${STREAM_ROW}.test(lines[i])) start = i + 1;
    const rows = lines.slice(start).filter((l) => l.trim() !== '');
    rows.pop();
    return rows.filter((l) => !/\\d+(\\.\\d+)?s\\b|tok\\/s|[\\u2800-\\u28ff]/.test(l)).join('\\n');
  };
`;
export const COMPOSER_READY = `${PRELUDE} return sep >= 0 && /❯/.test(composer);`;
/**
 * Home: the composer is empty and nothing is open. term2-next draws menus and dialogs as a box that closes right
 * above the separator (a resume list can be taller than half the screen); legacy draws them below it.
 */
export const DIALOG_OPEN = `
  // term2-next draws dialogs right above the separator (the nearest non-blank row is the box's bottom edge; a
  // markdown code box in the transcript has text after it); legacy draws menus below it.
  let above = sep - 1;
  while (above >= 0 && !lines[above].trim()) above--;
  const dialogOpen = sep >= 0 && ((above >= 0 && /^\\s*╰/.test(lines[above])) || lines.slice(sep + 1).some((l) => /^\\s*[╭╰]|Filter:/.test(l)));`;
export const AT_HOME = `${PRELUDE}${DIALOG_OPEN}
  if (sep < 0 || !/^\\s*❯\\s*$/.test(composer)) return false;
  return !dialogOpen;`;
