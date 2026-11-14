import {
  countFileLines,
  formatFullOutputSavedNote,
  saveOutputArtifact,
} from '../../../shared/utils/shell/shell-output.js';
import type { RunCodeExecution, RunCodeExecutionCall } from './run-code-execution.js';

/** The failing call's error is shown whole, up to this many characters. */
const MAX_MESSAGE_CHARS = 1_500;
const MAX_LISTED_CALLS = 15;
const MAX_LINE_REASON_CHARS = 100;
/** Completed results at or below this many characters are shown inline instead of spooled. */
const MAX_INLINE_RESULT_CHARS = 1_200;

type FailedScript = Extract<RunCodeExecution['script'], { status: 'failed' }>;

const clipText = (text: string, limit: number, note: string): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}\n[${note}]`;

const executedCalls = (calls: readonly RunCodeExecutionCall[]) => calls.filter((call) => call.outcome !== 'describe');

/**
 * Names the call and argument position in the script-visible error ("call 2")
 * with the total the script made ("call 2 of 3"), which only the final ledger knows.
 */
function describeFailure(diagnostic: FailedScript['diagnostic'], calls: readonly RunCodeExecutionCall[]): string {
  const total = executedCalls(calls).length;
  const message = diagnostic.message.replace(/ failed \(call (\d+), args /, (_all, position: string) => {
    return ` failed (call ${position} of ${Math.max(total, Number(position))}, args `;
  });
  if (diagnostic.code === 'unhandled_nested_failure') {
    // The host prefixes each message with its worker-local request id; that id means nothing to a model.
    const details = message
      .replace(/^unhandled_nested_failure: /, '')
      .replace(/(^|; )\d+: (?=(?:tools|agent)\.)/g, '$1');
    return (
      `A tool call failed and the script never awaited or caught it: ${details}\n` +
      'Await every tools.* call inside try/catch, or collect them with Promise.allSettled, so a failure is handled.'
    );
  }
  return clipText(message, MAX_MESSAGE_CHARS, `error cut at ${MAX_MESSAGE_CHARS} characters`);
}

const sizeOf = (result: unknown): number =>
  typeof result === 'string' ? result.length : (JSON.stringify(result) ?? '').length;

const renderValue = (result: unknown): string => {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return JSON.stringify(result, null, 2);
  // Keep multi-line text fields (file content) as readable lines rather than one escaped string.
  return Object.entries(result)
    .map(([key, value]) =>
      typeof value === 'string' && value.includes('\n') ? `${key}:\n${value}` : `${key}: ${JSON.stringify(value)}`,
    )
    .join('\n');
};

const label = (call: RunCodeExecutionCall): string =>
  `${call.position ?? '?'}. ${call.tool}${call.args ? ` ${call.args}` : ''}`;

function statusOf(call: RunCodeExecutionCall, failingPosition: number | undefined): string {
  switch (call.outcome) {
    case 'ok':
      if (!call.recovery) return 'ok';
      return call.recovery.truncated
        ? `ok, result cut at ${sizeOf(call.recovery.result)} characters` +
            (call.recovery.fullOutputPath ? ` (full result: ${call.recovery.fullOutputPath})` : '')
        : `ok, ${sizeOf(call.recovery.result)} characters`;
    case 'invalid_params':
      return 'invalid parameters, not run';
    case 'approval_required':
    case 'unknown_policy':
    case 'policy_error':
    case 'interceptor_denied':
      return 'not run, approval was refused';
    case 'unknown_tool':
      return 'unknown tool, not run';
    case 'unknown':
      return 'outcome unknown, it did not settle; inspect state before retrying';
    default:
      return call.position !== undefined && call.position === failingPosition
        ? 'FAILED (error above)'
        : `failed${call.reason ? `: ${clipText(call.reason, MAX_LINE_REASON_CHARS, 'cut')}` : ''}`;
  }
}

/** Completed results, readable as a file: one block per call. */
const spoolText = (completed: readonly RunCodeExecutionCall[]): string =>
  [...completed]
    .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
    .map((call) => `=== call ${label(call).replace('. ', ': ')} ===\n${renderValue(call.recovery!.result)}\n`)
    .join('\n');

/**
 * One line per call the script made, plus where the completed results are, so a
 * failed fan-out costs a re-request of what is missing and not a replay of everything.
 * Returns undefined when the failing call is the only one and there is nothing to add.
 */
async function describeCalls(
  calls: readonly RunCodeExecutionCall[],
  failingPosition: number | undefined,
): Promise<string | undefined> {
  const all = executedCalls(calls);
  const completed = all.filter((call) => call.outcome === 'ok' && call.recovery);
  if (completed.length === 0 && all.length < 2) return undefined;
  const ordered = [...all].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  const lines = ordered
    .slice(0, MAX_LISTED_CALLS)
    .map((call) => `  ${label(call)} - ${statusOf(call, failingPosition)}`);
  if (ordered.length > MAX_LISTED_CALLS) {
    const rest = ordered.slice(MAX_LISTED_CALLS);
    lines.push(`  ... ${rest.length} more calls (${rest.filter((call) => call.outcome === 'ok').length} ok)`);
  }
  const parts = [`Calls the script made before it stopped (host-observed):\n${lines.join('\n')}`];
  const total = completed.reduce((sum, call) => sum + sizeOf(call.recovery!.result), 0);
  if (completed.length > 0 && total <= MAX_INLINE_RESULT_CHARS) {
    parts.push(`Completed results:\n${spoolText(completed).trimEnd()}`);
  } else if (completed.length > 0) {
    try {
      const text = spoolText(completed);
      const note = formatFullOutputSavedNote(
        await saveOutputArtifact(text, { filenamePrefix: 'run-code-recovered' }),
        countFileLines(text),
      );
      parts.push(`Completed results (too long to show): ${note}. Read the part you need with read_file.`);
    } catch {
      parts.push('Completed results could not be saved; re-run only the calls whose result you still need.');
    }
  }
  parts.push(
    'Do not repeat completed calls; re-request only what is missing. Unknown outcomes are not proof of failure; ' +
      'inspect state before retrying. This is call evidence, not task success.',
  );
  return parts.join('\n');
}

/** Sections for a failed run: what went wrong, then what the script had already done. */
export async function renderFailureSections(
  diagnostic: FailedScript['diagnostic'],
  calls: readonly RunCodeExecutionCall[],
): Promise<string[]> {
  if (diagnostic.code === 'timeout' || diagnostic.code === 'deadline' || diagnostic.code === 'cancellation') {
    const lead =
      diagnostic.code === 'timeout'
        ? 'Script timed out.'
        : diagnostic.code === 'deadline'
        ? 'Script exceeded its deadline.'
        : 'Script was cancelled.';
    const listing = await describeCalls(calls, undefined);
    return [`${lead} ${diagnostic.message}`, ...(listing ? [listing] : [])];
  }
  const headline = `Script failed: ${describeFailure(diagnostic, calls)}`;
  const failingPosition = /^(?:tools|agent)\.\S+ failed \(call (\d+)/.exec(diagnostic.message)?.[1];
  const nestedRejection = failingPosition !== undefined || /^(?:tools|agent)\.\S+ failed/.test(diagnostic.message);
  const fanOut = nestedRejection && executedCalls(calls).length >= 2;
  const listing = await describeCalls(calls, failingPosition ? Number(failingPosition) : undefined);
  return [
    fanOut
      ? `${headline}\nThe script stopped at this rejection. The other calls' results are listed below. ` +
        'To continue past a failed call, catch it with try/catch; for calls run together, Promise.allSettled keeps every result where Promise.all drops them.'
      : headline,
    ...(listing ? [listing] : []),
  ];
}
