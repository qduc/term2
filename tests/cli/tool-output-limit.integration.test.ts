import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type ScriptedTurn,
} from '../helpers/loopback-chat-world.js';

// tools.maxOutputChars (default 20000), through the built CLI against a loopback provider that plays the model:
// the most one tool result may put into the model's context. What the model reads when a result is longer:
//   shell      keeps the start and the end, drops the middle behind `... [N characters trimmed] ...` (or
//              `... [N lines trimmed] ...` for output with many short lines)
//   run_code   keeps the start and drops the end, saying so: `[truncated: output was N characters, ...]`
//   read_file  keeps the start; the saved-output note is its only sign that the rest exists
// and, for each, a `Full output saved to `<file>` (N lines)` note naming a file with the whole output.
// The result, note included, stays within the limit. A result within the limit is passed as it is, and a
// different value moves the line: the same five calls are made under three limits.
//
// The shell commands only print; the sandbox is off (no bubblewrap in some environments) and approvals are
// bypassed with shell.autoApproveMode=always so the calls run headlessly.

const HEAD = 'HEAD-MARKER';
const TAIL = 'TAIL-MARKER';
/** One 4,000-character line between two markers (4,022 characters of output with the first marker's dash). */
const LONG_LINE = `${HEAD}-${'x'.repeat(4000)}-${TAIL}`;
const MANY_LINES = Array.from({ length: 400 }, (_, index) => `row ${index + 1}`).join('\n');
const SHORT = 'a short result';
const SCRIPT_TEXT = `${HEAD}-${'y'.repeat(3000)}-${TAIL}`;
const FILE_TEXT = Array.from({ length: 300 }, (_, index) => `line ${index + 1} ${'z'.repeat(24)}`).join('\n');

const CALLS: Array<{ id: string; turn: ScriptedTurn; size: number }> = [
  {
    id: 'long line',
    turn: { call: { tool: 'shell', args: { description: 'Print one long line', command: 'cat long-line.txt' } } },
    size: LONG_LINE.length,
  },
  {
    id: 'many lines',
    turn: { call: { tool: 'shell', args: { description: 'Print many lines', command: 'cat many-lines.txt' } } },
    size: MANY_LINES.length,
  },
  {
    id: 'short',
    turn: { call: { tool: 'shell', args: { description: 'Print a short line', command: `printf '%s' '${SHORT}'` } } },
    size: SHORT.length,
  },
  {
    id: 'run_code',
    turn: {
      call: {
        tool: 'run_code',
        args: { description: 'Return a long string', code: `return '${SCRIPT_TEXT}';` },
      },
    },
    size: SCRIPT_TEXT.length,
  },
  {
    id: 'read_file',
    turn: { call: { tool: 'read_file', args: { path: 'file.txt' } } },
    size: FILE_TEXT.length,
  },
];

async function runCalls(maxOutputChars: number | undefined) {
  const world = createWorld('term2-output-limit');
  const provider = await startLoopbackProvider({ turns: CALLS.map((call) => call.turn) });
  try {
    fs.writeFileSync(path.join(world.workspace, 'long-line.txt'), LONG_LINE);
    fs.writeFileSync(path.join(world.workspace, 'many-lines.txt'), MANY_LINES);
    fs.writeFileSync(path.join(world.workspace, 'file.txt'), FILE_TEXT);
    writeWorldSettings(world, provider.baseUrl, {
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'always' },
      ...(maxOutputChars === undefined ? {} : { tools: { maxOutputChars } }),
    });
    const result = await runCli(world, integrationCliPath(), ['--profile', 'bare', 'Run the calls']);
    expect(result.status, result.stderr).toBe(0);
    const requests = provider.requests();
    expect(requests).toHaveLength(CALLS.length + 1);
    // The last request carries every result, in call order.
    const results = toolResults(requests[requests.length - 1]);
    expect(results.map((entry) => entry.id)).toEqual(CALLS.map((_, index) => `call_${index + 1}`));
    // The note names a file the CLI wrote: read it back before the world goes.
    const saved = (text: string) => {
      const file = /Full output saved to `([^`]+)`/.exec(text)?.[1];
      return file === undefined
        ? undefined
        : { file, contents: fs.readFileSync(file, 'utf8'), inScratch: file.startsWith(world.scratch) };
    };
    return Object.fromEntries(
      CALLS.map((call, index) => [call.id, { text: results[index]!.text, saved: saved(results[index]!.text) }]),
    );
  } finally {
    await provider.close();
    removeWorld(world);
  }
}

/** The marker the cut leaves, and the number it states. */
const trimmedCharacters = (text: string) => Number(/\.\.\. \[(\d+) characters trimmed\] \.\.\./.exec(text)?.[1]);
const trimmedLines = (text: string) => Number(/\.\.\. \[(\d+) lines trimmed\] \.\.\./.exec(text)?.[1]);

describe.concurrent('tools.maxOutputChars', () => {
  it('cuts shell output to the limit, keeping both ends and saving the whole', { timeout: 30_000 }, async () => {
    const limit = 1000;
    const { 'long line': line, 'many lines': lines } = await runCalls(limit);

    // One long line: characters are trimmed from the middle; the model sees both markers and is told how many went.
    expect(line!.text.length).toBeLessThanOrEqual(limit);
    expect(line!.text).toContain(`${HEAD}-`);
    expect(line!.text).toContain(`-${TAIL}`);
    expect(trimmedCharacters(line!.text)).toBeGreaterThan(LONG_LINE.length - limit);
    expect(trimmedCharacters(line!.text)).toBeLessThan(LONG_LINE.length);
    expect(line!.saved?.inScratch).toBe(true);
    expect(line!.saved?.contents).toContain(LONG_LINE);

    // Many short lines: whole lines are dropped from the middle, the first and the last survive.
    expect(lines!.text.length).toBeLessThanOrEqual(limit);
    expect(lines!.text).toContain('row 1\n');
    expect(lines!.text).toContain('row 400');
    expect(lines!.text).not.toContain('row 200\n');
    expect(trimmedLines(lines!.text)).toBeGreaterThan(200);
    expect(trimmedLines(lines!.text)).toBeLessThan(400);
    expect(lines!.saved?.contents).toContain(MANY_LINES);
    expect(lines!.text).toMatch(/\(\d+ lines\)$/);
  });

  it('cuts run_code output at the end, and read_file output at the end', { timeout: 30_000 }, async () => {
    const limit = 1000;
    const { run_code: script, read_file: file } = await runCalls(limit);

    expect(script!.text.length).toBeLessThanOrEqual(limit);
    expect(script!.text).toContain(`${HEAD}-`);
    expect(script!.text).not.toContain(`-${TAIL}`);
    expect(script!.text).toContain(
      `[truncated: output was ${script!.saved!.contents.length} characters, ${
        script!.saved!.contents.length - limit
      } over the ${limit} limit, so the end was cut.`,
    );
    expect(script!.saved?.contents).toContain(SCRIPT_TEXT);

    expect(file!.text.length).toBeLessThanOrEqual(limit);
    expect(file!.text).toContain('line 1 ');
    expect(file!.text).not.toContain('line 300 ');
    expect(file!.saved?.contents).toContain('line 300 ');
  });

  it.each([
    { limit: 1000, cut: ['long line', 'many lines', 'run_code', 'read_file'] },
    { limit: 5000, cut: ['read_file'] },
    { limit: undefined, cut: [] as string[] },
  ])(
    'with a limit of $limit (default 20000) cuts exactly $cut and passes the rest whole',
    { timeout: 30_000 },
    async ({ limit, cut }) => {
      const results = await runCalls(limit);
      for (const call of CALLS) {
        const { text, saved } = results[call.id]!;
        if (cut.includes(call.id)) {
          expect(saved, `${call.id} is cut, with the saved-output note`).toBeDefined();
          expect(text.length, call.id).toBeLessThanOrEqual(limit ?? 20000);
        } else {
          expect(saved, `${call.id} is not cut`).toBeUndefined();
          expect(text, call.id).not.toMatch(/trimmed|truncated/);
        }
      }
      // What passes whole is the command's own output, byte for byte.
      if (!cut.includes('long line')) expect(results['long line']!.text).toContain(LONG_LINE);
      if (!cut.includes('many lines')) expect(results['many lines']!.text).toContain(MANY_LINES);
      if (!cut.includes('run_code')) expect(results.run_code!.text).toContain(SCRIPT_TEXT);
      if (!cut.includes('read_file')) expect(results.read_file!.text).toContain('300: line 300 ');
      expect(results.short!.text).toContain(SHORT);
    },
  );
});
