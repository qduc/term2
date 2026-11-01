import { stripVTControlCharacters } from 'node:util';

const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';
const MODEL_STATUS = /^[^\n]+\/[^\n]+ · ([^·]+) · [\d,]+ in \/ [\d,]+ out/;
const ACTIVE_CURSOR = /\x1b\[7m \x1b\[27m(?:\x1b\[[\d;]*m)*$/;

/** Native test entry selection, never a fallback from a failed source-marker wait. */
export function usesDirectComposer(args: readonly string[]): boolean {
  return args.some((arg) => arg.replaceAll('\\', '/').endsWith('/rewrite/src/app/cli.js'));
}
/**
 * Read the latest complete full Ink render's active single-line editor.
 * Ordinary composers are the default; value waits may opt into approval reasons.
 * Offsets index the decoded JS string, not bytes or source revision/generation counts.
 * A cursor is not proof of keyboard ownership: callers still need their independent
 * response/command boundary, and text submission requires a fresh exact value render.
 * The ordinary footer must share the product editor activation condition. Status
 * may be separated by ordinary notice/queue/goal rows. Wrapping, images and non-end
 * cursors deliberately do not match; this is not a terminal emulator or menu handshake.
 */
export function readDirectComposer(
  output: string,
  allowApprovalReason = false,
): { start: number; end: number; value: string; idle: boolean } | null {
  const start = output.lastIndexOf(BEGIN_FRAME);
  if (start < 0) return null;
  const end = output.indexOf(END_FRAME, start);
  if (end < 0) return null; // Never fall back to an older frame while a newer one is incomplete.
  // CR is the PTY line terminator, not composer content. Keep every other
  // byte intact: in particular, do not trim or collapse spaces in a draft.
  const lines = output
    .slice(start + BEGIN_FRAME.length, end)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  for (let index = lines.length - 2; index > 0; index -= 1) {
    const row = lines[index]!;
    const visible = stripVTControlCharacters(row);
    const footer = stripVTControlCharacters(lines[index + 1]!);
    if (!visible.startsWith('❯ ') || !ACTIVE_CURSOR.test(row)) continue;
    if (!/^Enter (?:send|steer) │ Alt\+Enter follow-up │/.test(footer)) continue;
    // Status panels are ordinary rows and may be separated from the composer
    // by Queue/memory/Goal/Command/notice rows. A footer between them would
    // indicate another render surface, so never anchor across one.
    let statusIndex = index - 1;
    while (statusIndex >= 0) {
      const candidate = stripVTControlCharacters(lines[statusIndex]!);
      if (/^Enter (?:send|steer) │ Alt\+Enter follow-up │/.test(candidate)) break;
      const phase = MODEL_STATUS.exec(candidate)?.[1];
      if (phase) return { start, end: end + END_FRAME.length, value: visible.slice(2, -1), idle: phase === 'idle' };
      statusIndex -= 1;
    }
  }
  // A value acknowledgement may belong to the active approval reason editor,
  // not the inactive ordinary composer. Never expose this surface as idle.
  if (
    allowApprovalReason &&
    lines.some((line) => MODEL_STATUS.exec(stripVTControlCharacters(line))?.[1] === 'awaiting_interaction')
  ) {
    const panel = lines.findIndex((line) => /^│ Allow this action\? *│$/.test(stripVTControlCharacters(line)));
    const reason = lines.findIndex(
      (line, index) =>
        index > panel &&
        /^│ Why\? \(or Esc to (?:cancel|go back)\) · Enter without a reason *│$/.test(stripVTControlCharacters(line)),
    );
    if (panel >= 0 && reason > panel) {
      const row = lines[reason + 1] ?? '';
      const cursor = /\x1b\[7m \x1b\[27m/.exec(row);
      const following = stripVTControlCharacters(lines[reason + 2] ?? '');
      if (
        cursor &&
        /^│ /.test(stripVTControlCharacters(row)) &&
        /^ *│$/.test(stripVTControlCharacters(row.slice(cursor.index + cursor[0].length))) &&
        /^│ Ctrl\+G return to composer *│$/.test(following)
      ) {
        return {
          start,
          end: end + END_FRAME.length,
          value: stripVTControlCharacters(row.slice(0, cursor.index)).slice(2),
          idle: false,
        };
      }
    }
  }
  return null;
}

/** Wait for a live child's current ordinary composer render, never transcript/PTY echo. */
export async function waitForDirectComposer(
  terminal: { getOutput(): string; hasExited(): boolean },
  options: { after?: number; value?: string; idle?: boolean; timeoutMs: number },
): Promise<number> {
  if (options.value !== undefined && !/^[\x20-\x7e]*$/.test(options.value)) {
    throw new Error('Direct composer acknowledgement supports only printable single-line fixture text.');
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    if (terminal.hasExited()) throw new Error('PTY child exited before direct composer readiness.');
    const frame = readDirectComposer(terminal.getOutput(), options.value !== undefined);
    if (
      frame &&
      frame.start >= (options.after ?? 0) &&
      (!options.idle || frame.idle) &&
      (options.value === undefined || frame.value === options.value)
    )
      return frame.end;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for direct ordinary composer render ${JSON.stringify(options)}.\n` +
      stripVTControlCharacters(terminal.getOutput()).slice(-1800),
  );
}
