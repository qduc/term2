import { stripVTControlCharacters } from 'node:util';

const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';

/** Native test entry selection, never a fallback from a failed source-marker wait. */
export function usesDirectComposer(args: readonly string[]): boolean {
  return args.some((arg) => arg.replaceAll('\\', '/').endsWith('/rewrite/src/app/cli.js'));
}
/**
 * Read only the latest complete, full Ink render's single-line composer.
 * Offsets index the decoded JS string, not bytes or source revision/generation counts.
 * A cursor is not proof of keyboard ownership: callers still need their independent
 * response/command boundary, and text submission requires a fresh exact value render.
 * Notices and queue rows may separate status from input. Idle means the rendered
 * session phase, not keyboard ownership; a fresh exact typed value acknowledges input.
 * Wrapping, images and non-end cursors do not match. This is not a menu handshake.
 */
export function readDirectComposer(
  output: string,
): { start: number; end: number; value: string; idle: boolean } | null {
  const start = output.lastIndexOf(BEGIN_FRAME);
  if (start < 0) return null;
  const end = output.indexOf(END_FRAME, start);
  if (end < 0) return null;
  const lines = output
    .slice(start + BEGIN_FRAME.length, end)
    .replaceAll('\r', '')
    .split('\n');
  for (let index = lines.length - 2; index > 0; index -= 1) {
    const row = lines[index]!;
    const visible = stripVTControlCharacters(row);
    const footer = stripVTControlCharacters(lines[index + 1]!);
    let statusIndex = index - 1;
    const statusPattern = /^[^\n]+\/[^\n]+ · ([^·]+) · [\d,]+ in \/ [\d,]+ out/;
    while (statusIndex > 0 && !statusPattern.test(stripVTControlCharacters(lines[statusIndex]!))) statusIndex -= 1;
    const phase = statusPattern.exec(stripVTControlCharacters(lines[statusIndex]!))?.[1];
    if (!phase || !visible.startsWith('❯ ') || !/\x1b\[7m \x1b\[27m(?:\x1b\[[\d;]*m)*$/.test(row)) continue;
    if (!/^Enter (?:send|steer) │ Alt\+Enter follow-up │/.test(footer)) continue;
    return { start, end: end + END_FRAME.length, value: visible.slice(2, -1), idle: phase === 'idle' };
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
