/** The startup warning `term2 acp` and `term2 serve` print when the shell sandbox cannot run. */
import { getDefaultShellSandboxRunner } from '../tools/shell/sandbox/shell-sandbox-runner.js';

/** Writes one line (without its newline) through `writeLine` when the sandbox is unavailable or its probe fails. */
export async function warnIfSandboxUnavailable(
  command: 'acp' | 'serve',
  writeLine: (line: string) => void,
): Promise<void> {
  const warn = (type: string, reason?: string): void =>
    writeLine(
      `term2 ${command}: warning: shell sandbox unavailable: ${type}${
        reason ? ` (${reason})` : ''
      }; shell tool calls will be refused`,
    );
  try {
    const availability = await getDefaultShellSandboxRunner().availability();
    if (availability.type !== 'available') {
      warn(availability.type, 'reason' in availability ? availability.reason : undefined);
    }
  } catch (error) {
    warn('probe_failed', error instanceof Error ? error.message : String(error));
  }
}
