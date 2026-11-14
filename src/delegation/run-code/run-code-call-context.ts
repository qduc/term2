import {
  isCapabilityOutcome,
  type CapabilityHandler,
  type CapabilityOutcome,
} from '../../tools/sandboxed-code-host/host-types.js';
import { TOOL_NAME_DESCRIBE } from '../../tools/system/run-code/script-surface.js';
import type { RunCodeCallRecord } from '../../tools/system/run-code/run-code-runtime-contract.js';

const MAX_ARG_STRING_CHARS = 60;
const MAX_ARGS_CHARS = 160;

/**
 * One-line echo of the arguments a nested call received. Long strings (patch or
 * file text) are cut per value first so one big field cannot crowd out the rest,
 * then the whole line is capped. It restates what the script itself passed.
 */
export function compactArgs(params: unknown): string {
  let text: string;
  try {
    text =
      JSON.stringify(params ?? {}, (_key, value) =>
        typeof value === 'string' && value.length > MAX_ARG_STRING_CHARS
          ? `${value.slice(0, MAX_ARG_STRING_CHARS - 3)}...(${value.length} chars)`
          : value,
      ) ?? '{}';
  } catch {
    text = '{}';
  }
  return text.length <= MAX_ARGS_CHARS ? text : `${text.slice(0, MAX_ARGS_CHARS - 3)}...`;
}

interface CallInfo {
  readonly position: number;
  readonly args: string;
}

const withLocation = (outcome: CapabilityOutcome, info: CallInfo): CapabilityOutcome => {
  if (outcome.kind !== 'result' || typeof outcome.result !== 'object' || outcome.result === null) return outcome;
  const result = outcome.result as Record<string, unknown>;
  if (Array.isArray(outcome.result) || result.ok !== false || typeof result.error !== 'string') return outcome;
  return {
    kind: 'result',
    result: { ...result, where: `call ${info.position}, args ${info.args}` } as typeof outcome.result,
  };
};

/**
 * Numbers the script's `tools.*` calls in dispatch order and remembers the
 * arguments each received, so a failure can say which call it was. Admission
 * order (the ledger's call ids) differs from dispatch order because argument
 * preparation is asynchronous; the position is taken before preparation starts.
 */
export function trackNestedCalls(tools: CapabilityHandler<any>, bridgeRunId: string) {
  let position = 0;
  const byPrepared = new WeakMap<object, CallInfo>();
  const byCallId = new Map<string, CallInfo>();
  const preparationFailures: Array<CallInfo & { tool: string }> = [];
  const prepare = tools.prepare.bind(tools);
  const invoke = tools.invoke.bind(tools);
  tools.prepare = async (payload) => {
    const tool = typeof payload.member === 'string' ? payload.member : '';
    if (tool === TOOL_NAME_DESCRIBE) return prepare(payload);
    const info = { position: ++position, args: compactArgs(payload.params) };
    const prepared = await prepare(payload);
    if (!isCapabilityOutcome(prepared)) {
      byPrepared.set(prepared as object, info);
      return prepared;
    }
    preparationFailures.push({ ...info, tool });
    return withLocation(prepared, info);
  };
  tools.invoke = async (prepared, context) => {
    const info = byPrepared.get(prepared as object);
    if (info) byCallId.set(`${bridgeRunId}:${context.callId}`, info);
    const outcome = await invoke(prepared, context);
    return info ? withLocation(outcome, info) : outcome;
  };
  return {
    /** Adds each ledger entry's dispatch position and argument echo. */
    annotate(calls: readonly RunCodeCallRecord[]): RunCodeCallRecord[] {
      const unmatched = [...preparationFailures];
      return calls.map((call) => {
        if (call.outcome === 'describe') return call;
        let info = call.callId ? byCallId.get(call.callId) : undefined;
        if (!info && !call.callId) {
          const index = unmatched.findIndex((failure) => failure.tool === call.tool);
          if (index >= 0) info = unmatched.splice(index, 1)[0];
        }
        return info ? { ...call, position: info.position, args: info.args } : call;
      });
    },
  };
}
