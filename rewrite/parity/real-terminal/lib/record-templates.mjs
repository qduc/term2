// Records template conversations by driving each CLI in a pty against the fake provider. The store generator
// only clones these blocks (fresh ids, times, seq), so every line it writes has a shape the CLI itself wrote,
// including how each CLI caps and references a large tool output.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { startProvider, lastUserText, afterToolResult, isCompactionRequest } from './provider.mjs';
import { prepareHome, makeRoot, CLIS } from './env.mjs';

const require = createRequire(import.meta.url);
const pty = require('@lydell/node-pty');

// Markers the generator looks for: which file a tool block read, and the streamed reply's delta tokens
// (a line with one token is a per-delta record, a line with all of them is the joined reply).
export const SMALL_FILE = 'small.txt';
export const LARGE_FILE = 'large.txt';
export const DELTA_COUNT = 40;
export const deltaToken = (i) => `rtd${String(i).padStart(6, '0')} `;
export const PROMPT_MARK = 'RT-PROMPT';
// Manual /compact needs an explicit threshold for an uncatalogued model in both CLIs.
export const COMPACTION_SETTINGS = {
  agent: {
    contextCompaction: { enabled: false, mode: 'local', compactThresholdTokens: 100_000 },
    maxRequestInputTokens: 200_000,
  },
};

function responder(body, n, raw) {
  if (isCompactionRequest(raw)) return { text: 'RT-SUMMARY compacted summary of the earlier work.' };
  if (afterToolResult(body)) return { text: 'RT-AFTER-TOOL I read the file; it holds generated rows.' };
  const prompt = lastUserText(body);
  if (prompt.includes('read the small file')) {
    return { toolCalls: [{ name: 'shell', arguments: { command: `cat ${SMALL_FILE}` } }] };
  }
  if (prompt.includes('read the large file')) {
    return { toolCalls: [{ name: 'shell', arguments: { command: `cat ${LARGE_FILE}` } }] };
  }
  if (prompt.includes('stream')) {
    return { deltas: Array.from({ length: DELTA_COUNT }, (_, i) => deltaToken(i)), everyMs: 2 };
  }
  return { text: `RT-REPLY ${n} plain answer.` };
}

const WORDS = 'buffer render session cache index stream token module export value handler request config parser layout'.split(' ');

/** Build-log style lines; the large file is far past both CLIs' output caps, so each applies its own. */
function generatedFile(lines) {
  let seed = lines;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pickWord = () => WORDS[Math.floor(next() * WORDS.length)];
  return (
    Array.from(
      { length: lines },
      (_, i) => `src/${pickWord()}/${pickWord()}.ts:${i + 1}: ${Array.from({ length: 8 }, pickWord).join(' ')}`,
    ).join('\n') + '\n'
  );
}

async function drive(cli, env, cwd, steps) {
  const child = pty.spawn(process.execPath, [cli], { name: 'xterm-256color', cols: 160, rows: 50, cwd, env });
  let out = '';
  child.onData((data) => (out += data));
  let exited = false;
  child.onExit(() => (exited = true));
  const seen = () => stripVTControlCharacters(out);
  const waitFor = async (needle, from, timeoutMs = 60_000) => {
    const started = Date.now();
    while (!seen().slice(from).includes(needle)) {
      if (exited || Date.now() - started > timeoutMs) {
        throw new Error(`template recording: waiting for ${needle}\n${seen().slice(-1500)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await waitFor('❯', 0);
  await pause(800);
  for (const step of steps) {
    const from = seen().length;
    for (const ch of step.type) {
      child.write(ch);
      await pause(4);
    }
    await pause(150);
    child.write('\r');
    await waitFor(step.until, from);
    await pause(step.settleMs ?? 1500);
  }
  child.write('\x03');
  await pause(300);
  child.write('\x03');
  const started = Date.now();
  while (!exited && Date.now() - started < 15_000) await pause(50);
  if (!exited) child.kill('SIGKILL');
}

/** Record the template conversation for one CLI; returns its conversation directory. */
export async function recordTemplates(which, scratch) {
  const provider = await startProvider(responder);
  try {
    const record = async (steps) => {
      const home = prepareHome({
        root: makeRoot(scratch, which),
        baseUrl: provider.baseUrl,
        settings: COMPACTION_SETTINGS,
      });
      fs.writeFileSync(path.join(home.workspace, SMALL_FILE), generatedFile(30));
      fs.writeFileSync(path.join(home.workspace, LARGE_FILE), generatedFile(20_000));
      await drive(CLIS[which].cli, home.env, home.workspace, steps);
      return home.conversations;
    };
    const long = await record([
      { type: `${PROMPT_MARK} please read the small file`, until: 'RT-AFTER-TOOL' },
      { type: `${PROMPT_MARK} please read the large file`, until: 'RT-AFTER-TOOL' },
      { type: `${PROMPT_MARK} now stream the reply`, until: deltaToken(DELTA_COUNT - 1).trim() },
      { type: `${PROMPT_MARK} one more question`, until: 'plain answer', settleMs: 2500 },
      { type: '/compact', until: 'ompact', settleMs: 4000 },
      { type: `${PROMPT_MARK} after the compaction`, until: 'plain answer' },
    ]);
    return { long };
  } finally {
    await provider.close();
  }
}
