/** Captured terminal evidence for validation-shaped subagent shell commands. */
import type { ValidationEvidence } from './types.js';

/** A mutable holder for the last validation evidence captured from a shell run. */
export interface ValidationCapture {
  value?: ValidationEvidence;
}

/** Heuristic for validation-shaped shell commands (test/lint/typecheck/build/tsc). */
const VALIDATION_COMMAND_PATTERNS = [
  /\bnpm\s+run\s+(test|lint|typecheck|tsc|build|check)\b/i,
  /\bnpx\s+(vitest|jest|tsc|eslint|prettier)\b/i,
  /\bpnpm\s+(run\s+)?(test|lint|typecheck|tsc|build|check)\b/i,
  /\byarn\s+(test|lint|typecheck|tsc|build|check)\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\btsc\b/i,
  /\beslint\b/i,
  /\bprettier\b/i,
  /\b(test|lint|typecheck|build)\s*$/i,
  /\bpnpm\s+test\b/i,
  /\bnpm\s+test\b/i,
];

function isValidationCommand(command: string): boolean {
  return VALIDATION_COMMAND_PATTERNS.some((re) => re.test(command));
}

const MAX_VALIDATION_EXCERPT = 2000;

/**
 * Parse the terminal status line emitted by the shell tool.
 *
 * This deliberately only considers the first line. The remaining output is
 * command-owned text and can mention exit codes (or claim success) without
 * being evidence of how the command terminated.
 */
function parseExitStatus(result: string): number | undefined {
  const terminalStatus = result.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const exitMatch = terminalStatus.match(/^exit\s+(\d+)$/i);
  if (exitMatch) return parseInt(exitMatch[1], 10);
  return undefined;
}

function buildValidationEvidence(command: string, result: string): ValidationEvidence {
  const exitStatus = parseExitStatus(result) ?? 'unknown';
  const excerpt =
    result.length > MAX_VALIDATION_EXCERPT ? result.slice(-(MAX_VALIDATION_EXCERPT - 20)) + '\n...(truncated)' : result;
  return { command, exitStatus, outputExcerpt: excerpt };
}

export function captureValidationIfMatch(
  capture: ValidationCapture | undefined,
  command: string,
  result: unknown,
): void {
  if (!capture) return;
  if (!isValidationCommand(command)) return;
  const resultStr = typeof result === 'string' ? result : String(result ?? '');
  capture.value = buildValidationEvidence(command, resultStr);
}
