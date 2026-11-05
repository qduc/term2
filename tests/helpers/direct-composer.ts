import { stripVTControlCharacters } from 'node:util';

const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';
const MODEL_STATUS = /^[^\n]+\/[^\n]+ · ([^·]+) · [\d,]+ in \/ [\d,]+ out/;
const ACTIVE_CURSOR = /\x1b\[7m \x1b\[27m(?:\x1b\[[\d;]*m)*$/;

/**
 * Read the latest complete full Ink render's active single-line editor.
 * Only the ordinary composer matches.
 * Offsets index the decoded JS string, not bytes or source revision/generation counts.
 * A cursor is not proof of keyboard ownership: callers still need their independent
 * response/command boundary, and text submission requires a fresh exact value render.
 * The ordinary footer must share the product editor activation condition. Status
 * may be separated by ordinary notice/queue/goal rows. Wrapping, images and non-end
 * cursors deliberately do not match; this is not a terminal emulator or menu handshake.
 */
export function readDirectComposer(
  output: string,
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
      // An interrupted terminal can leave the ordinary composer ready for a new turn.
      // Require its real send footer as well as the active cursor; never count a live steer.
      if (phase)
        return {
          start,
          end: end + END_FRAME.length,
          value: visible.slice(2, -1),
          idle: phase === 'idle' || (phase === 'interrupted' && footer.startsWith('Enter send │')),
        };
      statusIndex -= 1;
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
    const frame = readDirectComposer(terminal.getOutput());
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
