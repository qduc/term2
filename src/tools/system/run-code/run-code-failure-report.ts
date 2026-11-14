import type { RunCodeExecution, RunCodeExecutionCall } from './run-code-execution.js';

type FailedScript = Extract<RunCodeExecution['script'], { status: 'failed' }>;

/**
 * Completes the call position the script-visible error carries ("call 2") with the
 * total the script made ("call 2 of 3"), which only the final ledger knows.
 */
export function describeFailureMessage(
  diagnostic: FailedScript['diagnostic'],
  calls: readonly RunCodeExecutionCall[],
): string {
  const total = calls.filter((call) => call.outcome !== 'describe').length;
  return diagnostic.message.replace(/ failed \(call (\d+), args /, (_all, position: string) => {
    return ` failed (call ${position} of ${Math.max(total, Number(position))}, args `;
  });
}
