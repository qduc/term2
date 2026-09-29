import type {
  CapabilityHandler,
  CapabilityOutcome,
  JsonValue,
} from '../../../services/sandboxed-code-host/host-types.js';
import type { ILoggingService, ISettingsService } from '../../../services/service-interfaces.js';
import {
  resolveAgentSpecForChild,
  type AgentSpecAuthoritySnapshot,
  type AgentSpecBoundaryResult,
} from '../../../services/agent-runtime/permission-boundary.js';
import type {
  NestedSubagentResult,
  SubagentCancelAcknowledgement,
  SubagentResult,
  SubagentRunHandle,
  SubagentRunStatus,
} from '../../../services/subagents/types.js';
import type { ResolvedSubagentLaunch } from '../../../lib/subagent-bridge.js';
import { RUN_CODE_LIMITS } from './run-code-runtime.js';

/**
 * Host-owned bridge callbacks the script `agent` capability launches through.
 * Only the resolved-definition entry points of {@link '../lib/subagent-bridge.js'}
 * appear here: a raw script spec can never reach a raw `runSubagent` callback,
 * because the only path from script input to a launch goes through
 * `resolveAgentSpecForChild` first.
 */
export interface RunCodeAgentSpecBridge {
  settings: ISettingsService;
  runResolvedSubagent?: (
    params: ResolvedSubagentLaunch,
    context?: unknown,
    details?: unknown,
  ) => Promise<NestedSubagentResult>;
  /** The four async members exist together or not at all. */
  runResolvedSubagentAsync?: (params: ResolvedSubagentLaunch) => Promise<SubagentRunHandle>;
  getSubagentResult?: (params: { runId: string }, context?: unknown, details?: unknown) => Promise<SubagentResult>;
  getSubagentStatus?: (
    params: { runId?: string },
    context?: unknown,
    details?: unknown,
  ) => SubagentRunStatus | SubagentRunStatus[];
  cancelSubagentRun?: (params: { target: string }) => SubagentCancelAcknowledgement;
}

export interface RunCodeAgentCapabilityDeps extends RunCodeAgentSpecBridge {
  authority: AgentSpecAuthoritySnapshot;
  logger: ILoggingService;
  onCallAdmitted?: (member: string, started: number, callId: string) => void;
  onCallSettled?: (
    member: string,
    started: number,
    callId: string,
    outcome: 'ok' | 'error' | 'unknown',
    reason?: string,
  ) => void;
}

/** Per-run state a script invocation owns. */
export interface RunCodeAgentCapabilityInvocation {
  bridgeRunId: string;
  context?: unknown;
}

const ASYNC_LIFECYCLE_MEMBERS = ['start', 'status', 'result', 'cancel'] as const;

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';

/** True when at least one launch seam exists; gates capability existence. */
export function isRunCodeAgentBridgeActive(
  bridge: RunCodeAgentSpecBridge | undefined,
): bridge is RunCodeAgentSpecBridge {
  if (!bridge) return false;
  const foreground = isFunction(bridge.runResolvedSubagent);
  const asyncLifecycle =
    isFunction(bridge.runResolvedSubagentAsync) &&
    isFunction(bridge.getSubagentResult) &&
    isFunction(bridge.getSubagentStatus) &&
    isFunction(bridge.cancelSubagentRun);
  return foreground || asyncLifecycle;
}

/** The exact member list a bound bridge can serve; also rendered into the tool description. */
export function getRunCodeAgentCapabilityMembers(bridge: RunCodeAgentSpecBridge): string[] {
  const members: string[] = [];
  if (isFunction(bridge.runResolvedSubagent)) members.push('run');
  if (
    isFunction(bridge.runResolvedSubagentAsync) &&
    isFunction(bridge.getSubagentResult) &&
    isFunction(bridge.getSubagentStatus) &&
    isFunction(bridge.cancelSubagentRun)
  ) {
    members.push(...ASYNC_LIFECYCLE_MEMBERS);
  }
  return members;
}

type SuccessfulBoundary = Extract<AgentSpecBoundaryResult, { ok: true }>;

type PreparedAgentLaunch =
  | { member: 'run'; boundary: SuccessfulBoundary; started: number }
  | {
      member: 'start';
      boundary: SuccessfulBoundary;
      name?: string;
      started: number;
    };

type PreparedAgentLifecycle =
  | { member: 'status'; runId?: string; started: number }
  | { member: 'result'; runId: string; started: number }
  | { member: 'cancel'; target: string; started: number };

type PreparedAgentCall = PreparedAgentLaunch | PreparedAgentLifecycle;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const rejectCall = (error: string): CapabilityOutcome => ({
  kind: 'result',
  result: { ok: false, error } as JsonValue,
});

const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError';

/** `costRecords` and `nestedRunResult` are host-owned: possibly large, possibly not JSON-safe. */
const projectNestedResult = (result: NestedSubagentResult | SubagentResult): JsonValue => {
  const { costRecords: _costRecords, nestedRunResult: _nestedRunResult, ...projected } = result;
  // The host re-serializes capability results through JSON, so any plain-data
  // projection is transportable even without a JsonValue index signature.
  return projected as unknown as JsonValue;
};

const AGENT_MEMBERS = ['run', 'start', 'status', 'result', 'cancel'] as const;
type AgentMember = (typeof AGENT_MEMBERS)[number];

const LAUNCH_PARAM_FIELDS = new Set(['spec', 'worktree', 'name', 'continue_run_id']);

/** Light, admission-time param checks. Deep AgentSpec validation is the boundary's job. */
function launchParamError(member: 'run' | 'start', params: Record<string, unknown>): string | undefined {
  const accepted = member === 'run' ? new Set(['spec', 'worktree']) : LAUNCH_PARAM_FIELDS;
  for (const key of Object.keys(params)) {
    if (!accepted.has(key)) return `unsupported param "${key}"; agent.${member} accepts ${[...accepted].join(', ')}.`;
  }
  if (!isRecord(params.spec) || Array.isArray(params.spec)) return 'spec must be a plain AgentSpec object.';
  if (params.worktree !== undefined && typeof params.worktree !== 'string') return 'worktree must be a string.';
  if (params.name !== undefined && typeof params.name !== 'string') return 'name must be a string.';
  if (params.continue_run_id !== undefined && typeof params.continue_run_id !== 'string') {
    return 'continue_run_id must be a string.';
  }
  if (member === 'start' && params.continue_run_id !== undefined) {
    return 'continue_run_id is not supported by script agent.start until continuation authority can be verified.';
  }
  return undefined;
}

function lifecycleParamError(
  member: 'status' | 'result' | 'cancel',
  params: Record<string, unknown>,
): string | undefined {
  const accepted = member === 'status' ? new Set(['runId']) : new Set([member === 'result' ? 'runId' : 'target']);
  for (const key of Object.keys(params)) {
    if (!accepted.has(key)) return `unsupported param "${key}"; agent.${member} accepts ${[...accepted].join(', ')}.`;
  }
  const required = member === 'cancel' ? 'target' : 'runId';
  if (member !== 'status' && (params[required] === undefined || typeof params[required] !== 'string')) {
    return `${required} must be a string.`;
  }
  if (member === 'status' && params.runId !== undefined && typeof params.runId !== 'string') {
    return 'runId must be a string.';
  }
  return undefined;
}

/**
 * The script-only `agent` capability of one run_code invocation.
 *
 * Every launch resolves an untrusted script AgentSpec through
 * `resolveAgentSpecForChild` against the host-bound root authority snapshot
 * before any bridge callback sees it; the boundary result — never the raw
 * spec — is what reaches the host bridge. Start admission is a synchronous
 * check-and-increment before resolution, so a script can never race itself
 * past the launch cap, and an over-cap start is rejected before the manager
 * launches anything while already-admitted siblings continue untouched.
 */
export function createRunCodeAgentCapability(
  deps: RunCodeAgentCapabilityDeps,
  invocation: RunCodeAgentCapabilityInvocation,
): CapabilityHandler<PreparedAgentCall> {
  const members = getRunCodeAgentCapabilityMembers(deps);
  if (members.length === 0) {
    throw new Error('run_code agent capability requires a resolved-launch or async lifecycle bridge.');
  }
  // Synchronous admission counter: `prepare` never awaits between the cap
  // check and the increment, so concurrent script starts cannot exceed it.
  let startsAdmitted = 0;

  return {
    binding: { name: 'agent', kind: 'namespace', members },
    limits: {
      maxCalls: RUN_CODE_LIMITS.maxAgentCalls,
      maxConcurrency: RUN_CODE_LIMITS.maxAgentConcurrency,
      limitExceededMessage: `Agent call limit reached (${RUN_CODE_LIMITS.maxAgentCalls} agent.* calls per script run).`,
    },
    overBudget: ({ usedCalls, maxCalls }) =>
      rejectCall(
        `Agent call limit reached (${maxCalls} agent.* calls per script run; ${usedCalls} admitted, ${Math.max(
          0,
          maxCalls - usedCalls,
        )} remaining). Return the partial results you collected.`,
      ),
    onAdmitted: (prepared, context) => {
      const callId = `${invocation.bridgeRunId}:agent:${context.callId}`;
      deps.onCallAdmitted?.(prepared.member, prepared.started, callId);
    },
    onAborted: (prepared, context, reason) => {
      const callId = `${invocation.bridgeRunId}:agent:${context.callId}`;
      deps.onCallSettled?.(prepared.member, prepared.started, callId, 'unknown', reason);
    },
    lane: (prepared) => (prepared.member === 'run' || prepared.member === 'start' ? 'default' : 'serial'),
    prepare: (payload) => {
      const started = Date.now();
      const requested = typeof payload.member === 'string' ? payload.member : '';
      if (!(AGENT_MEMBERS as readonly string[]).includes(requested)) {
        return rejectCall(`Unknown agent member "${requested}". Available: ${members.join(', ')}.`);
      }
      const member = requested as AgentMember;
      const params = isRecord(payload.params) ? payload.params : {};

      if (member === 'run' || member === 'start') {
        const paramError = launchParamError(member, params);
        if (paramError) return rejectCall(`agent.${member} params invalid: ${paramError}`);
        // Admit the start before resolving so the cap holds regardless of what
        // resolution does; a rejected spec consumes its admission like a
        // launched one would, keeping the budget an honest upper bound.
        if (startsAdmitted >= RUN_CODE_LIMITS.maxAgentStarts) {
          return rejectCall(
            `Agent start limit reached (${RUN_CODE_LIMITS.maxAgentStarts} agent launches per script run; ` +
              `${startsAdmitted} admitted, 0 remaining). Return the partial results you collected; ` +
              'admitted launches are unaffected.',
          );
        }
        startsAdmitted += 1;
        const boundary = resolveAgentSpecForChild(params.spec, {
          settings: deps.settings,
          logger: deps.logger,
          parent: deps.authority.parent,
          readOnly: deps.authority.readOnly,
          planMode: deps.authority.planMode,
          ...(typeof params.worktree === 'string' ? { worktree: params.worktree } : {}),
        });
        if (!boundary.ok) {
          return rejectCall(
            `Agent specification rejected: ${boundary.errors.map((error) => error.message).join('; ')}`,
          );
        }
        return member === 'run'
          ? ({ member, boundary, started } satisfies PreparedAgentCall)
          : ({
              member,
              boundary,
              ...(typeof params.name === 'string' ? { name: params.name } : {}),
              started,
            } satisfies PreparedAgentCall);
      }

      const lifecycleError = lifecycleParamError(member, params);
      if (lifecycleError) return rejectCall(`agent.${member} params invalid: ${lifecycleError}`);
      if (member === 'status') {
        return {
          member,
          ...(typeof params.runId === 'string' ? { runId: params.runId } : {}),
          started,
        } satisfies PreparedAgentCall;
      }
      if (member === 'result') {
        return { member, runId: params.runId as string, started } satisfies PreparedAgentCall;
      }
      return { member: 'cancel', target: params.target as string, started } satisfies PreparedAgentCall;
    },
    invoke: async (prepared, callContext): Promise<CapabilityOutcome> => {
      const callId = `${invocation.bridgeRunId}:agent:${callContext.callId}`;
      try {
        const outcome = await (async (): Promise<CapabilityOutcome> => {
          if (prepared.member === 'run') {
            try {
              const nested = await deps.runResolvedSubagent!.call(
                undefined,
                { resolvedDefinition: prepared.boundary },
                invocation.context,
                // The host controller signal aborts the child on script timeout or
                // cancellation; the tool call id keeps foreground leases movable.
                {
                  toolCall: { callId: `${invocation.bridgeRunId}:agent:${callContext.callId}` },
                  signal: callContext.signal,
                },
              );
              return { kind: 'result', result: { ok: true, result: projectNestedResult(nested) } as JsonValue };
            } catch (error) {
              if (callContext.signal.aborted || isAbortError(error)) throw error;
              return rejectCall(error instanceof Error ? error.message : String(error));
            }
          }
          if (prepared.member === 'start') {
            try {
              const handle = await deps.runResolvedSubagentAsync!.call(undefined, {
                resolvedDefinition: prepared.boundary,
                ...(prepared.name ? { name: prepared.name } : {}),
              });
              return {
                kind: 'result',
                result: {
                  ok: true,
                  result: {
                    runId: handle.runId,
                    ...(handle.name ? { name: handle.name } : {}),
                    role: handle.role,
                    status: handle.status,
                  } as JsonValue,
                } as JsonValue,
              };
            } catch (error) {
              // Launch failures are script-catchable; the background run is never
              // bound to this script's signal, so there is no abort case here.
              return rejectCall(error instanceof Error ? error.message : String(error));
            }
          }
          if (prepared.member === 'status') {
            const status = deps.getSubagentStatus!.call(
              undefined,
              prepared.runId !== undefined ? { runId: prepared.runId } : {},
              invocation.context,
            );
            return { kind: 'result', result: { ok: true, result: status as unknown as JsonValue } };
          }
          if (prepared.member === 'result') {
            try {
              const settled = await deps.getSubagentResult!.call(
                undefined,
                { runId: prepared.runId },
                invocation.context,
                {
                  signal: callContext.signal,
                },
              );
              return { kind: 'result', result: { ok: true, result: projectNestedResult(settled) } as JsonValue };
            } catch (error) {
              if (callContext.signal.aborted || isAbortError(error)) throw error;
              return rejectCall(error instanceof Error ? error.message : String(error));
            }
          }
          const acknowledgement = deps.cancelSubagentRun!.call(undefined, { target: prepared.target });
          return { kind: 'result', result: { ok: true, result: acknowledgement as unknown as JsonValue } };
        })();
        const result = outcome.kind === 'result' && isRecord(outcome.result) ? outcome.result : undefined;
        const failed = outcome.kind === 'fail' || result?.ok === false;
        const reason = failed && typeof result?.error === 'string' ? result.error : undefined;
        deps.onCallSettled?.(prepared.member, prepared.started, callId, failed ? 'error' : 'ok', reason);
        return outcome;
      } catch (error) {
        deps.onCallSettled?.(
          prepared.member,
          prepared.started,
          callId,
          'error',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
  };
}
