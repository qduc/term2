/** Accepted direct facts -> the existing public observational hook contract. */
import { randomUUID } from 'node:crypto';
import type {
  Term2HookEvent,
  Term2HookEventMap,
  Term2HookEventName,
  Term2HookScope,
  Term2SessionMode,
  Term2Status,
  Term2StatusChangeReason,
  Term2ApprovalResolutionSource,
} from './hooks/hook-contracts.js';
import type { HookLifecyclePort } from './hooks/hook-service.js';
import type { FactLine } from './facts.js';
import type { ModelRef } from '../model/index.js';
import type { ExecutionId } from '../tools/index.js';

export type DirectHookOptions = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mode: Term2SessionMode;
  readonly model: ModelRef;
  /** Pass a started HookService; discovery/trust/timeout policy stays in that runner. */
  readonly lifecycle: HookLifecyclePort;
  readonly includeUserText?: boolean;
  readonly includeToolArguments?: boolean;
  readonly includeToolResults?: boolean;
  /** Background/subagent ownership comes from Session, never inferred from provider ids. */
  readonly scopeForExecution?: (executionId: ExecutionId) => Term2HookScope;
  readonly diagnostic?: (message: string, error: unknown) => void;
};
type Payload<Name extends Term2HookEventName> = Omit<
  Term2HookEventMap[Name],
  'type' | 'schemaVersion' | 'eventId' | 'sessionId' | 'timestamp' | 'scope'
>;
export type DirectHookAcceptedMetadata = {
  readonly origin?: 'user' | 'queued' | 'approval_continuation';
  readonly attempt?: number;
  /** Accepted Session provenance; unknown sources are system, never invented as user consent. */
  readonly resolutionSource?: Term2ApprovalResolutionSource;
  readonly automaticApproval?: boolean;
  readonly executionFollowed?: boolean;
};
type Correlation = { readonly turnId?: string; readonly toolCallId?: string; readonly scope?: Term2HookScope };

/** Bounded hook payload only; never changes execution, persistence or model input. */
function summary(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length <= 500 ? value : `${text.slice(0, 500)}...`;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Passive lifecycle observer; its maps hold hook correlation/timing only. Call
 * accepted() in commit order, for live accepted facts, never as a replay side
 * effect. A background approval changes status only if Session says it does.
 * Hook exceptions cannot approve, deny, retry, poison a writer or fail a tool.
 */
export function createDirectHooks(options: DirectHookOptions): {
  start(at?: number): Promise<void>;
  accepted(line: FactLine, metadata?: DirectHookAcceptedMetadata): Promise<void>;
  status(previous: Term2Status, current: Term2Status, reason: Term2StatusChangeReason, turnId?: string): Promise<void>;
  end(reason?: 'normal' | 'fatal_error', at?: number): Promise<void>;
} {
  let startedAt: number | undefined;
  let ended = false;
  let lastSequence = 0;
  const turns = new Map<string, number>();
  const executions = new Map<
    string,
    { at: number; toolName: string; callId: string; turnId: string; scope: Term2HookScope }
  >();
  const calls = new Map<string, string>();
  const requests = new Map<string, { turnId: string; toolCallId?: string; scope: Term2HookScope }>();
  const diagnostic = (message: string, error: unknown): void => {
    try {
      options.diagnostic?.(message, error);
    } catch {
      /* Observation cannot change runtime behavior. */
    }
  };
  const emit = async <Name extends Term2HookEventName>(
    type: Name,
    payload: Payload<Name>,
    correlation: Correlation = {},
    at = Date.now(),
    eventId: string = randomUUID(),
  ): Promise<void> => {
    if (ended) return;
    const { scope = 'root', ...ids } = correlation;
    const event = {
      ...payload,
      ...ids,
      type,
      schemaVersion: 1,
      eventId,
      sessionId: options.sessionId,
      timestamp: at,
      scope,
    } as Term2HookEvent<Name>;
    try {
      await options.lifecycle.emit(event);
    } catch (error) {
      diagnostic(`Hook emission failed: ${type}`, error);
    }
  };
  const start = async (at = Date.now()): Promise<void> => {
    if (startedAt !== undefined || ended) return;
    startedAt = at;
    await emit(
      'session.start',
      {
        cwd: options.cwd,
        mode: options.mode,
        providerName: options.model.provider,
        modelName: options.model.model,
      },
      {},
      at,
    );
  };
  return {
    start,
    async status(previous, current, reason, turnId) {
      await emit('status.change', { previous, current, reason }, { turnId });
    },
    async accepted(line, metadata = {}) {
      try {
        if (ended || line.seq <= lastSequence) return;
        lastSequence = line.seq;
        const at = Date.parse(line.at);
        const timestamp = Number.isFinite(at) ? at : Date.now();
        const fact = line.fact;
        const eventId = (name: Term2HookEventName): string => `${options.sessionId}:${line.seq}:${name}`;
        const send = <Name extends Term2HookEventName>(
          type: Name,
          payload: Payload<Name>,
          ids: Correlation = {},
        ): Promise<void> => emit(type, payload, ids, timestamp, eventId(type));
        switch (fact.type) {
          case 'session_started':
            await start(timestamp);
            break;
          case 'turn_started': {
            turns.set(fact.turnId, timestamp);
            const userText = fact.input
              .flatMap((item) =>
                item.type === 'user_message'
                  ? item.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  : [],
              )
              .join('\n');
            await send(
              'turn.start',
              {
                origin: metadata.origin ?? 'user',
                ...(options.includeUserText ? { userText } : {}),
              },
              { turnId: fact.turnId },
            );
            break;
          }
          case 'item': {
            if (fact.executionId && fact.item.type === 'tool_call') calls.set(fact.executionId, fact.item.callId);
            break;
          }
          case 'tool_started': {
            const scope = options.scopeForExecution?.(fact.executionId) ?? 'root';
            executions.set(fact.executionId, {
              at: timestamp,
              toolName: fact.toolName,
              callId: fact.callId,
              turnId: fact.turnId,
              scope,
            });
            await send(
              'tool.before',
              {
                toolName: fact.toolName,
                normalizedArguments: options.includeToolArguments ? fact.input : summary(fact.input),
                attempt: metadata.attempt ?? 1,
                ownership: scope,
              },
              { turnId: fact.turnId, toolCallId: fact.callId, scope },
            );
            break;
          }
          case 'tool_finished': {
            const execution = executions.get(fact.executionId);
            if (!execution) break; // Recovery facts never invent a physical invocation.
            executions.delete(fact.executionId);
            calls.delete(fact.executionId);
            const duration = Math.max(0, timestamp - execution.at);
            const ids = { turnId: execution.turnId, toolCallId: execution.callId, scope: execution.scope };
            if (fact.result.isError)
              await send(
                'tool.error',
                {
                  toolName: execution.toolName,
                  duration,
                  errorCategory: 'tool',
                  safeMessage: fact.result.output.slice(0, 500),
                  convertedToModelResult: true,
                },
                ids,
              );
            else
              await send(
                'tool.after',
                {
                  toolName: execution.toolName,
                  duration,
                  normalizedResultSummary: options.includeToolResults
                    ? fact.result.output
                    : summary(fact.result.output),
                },
                ids,
              );
            break;
          }
          case 'interaction_opened': {
            const request = fact.request;
            const scope = request.executionId ? options.scopeForExecution?.(request.executionId) ?? 'root' : 'root';
            const execution = request.executionId ? executions.get(request.executionId) : undefined;
            const ids = {
              turnId: fact.turnId,
              toolCallId:
                request.sourceCallId ??
                execution?.callId ??
                (request.executionId ? calls.get(request.executionId) : undefined),
              scope,
            };
            requests.set(request.requestId, ids);
            await send(
              'approval.requested',
              {
                toolName: request.toolName,
                normalizedArguments: options.includeToolArguments ? request.input : summary(request.input),
                approvalKind: request.kind === 'question' ? 'ask_user' : 'tool',
                proposedDecision: 'approve',
              },
              ids,
            );
            break;
          }
          case 'interaction_closed': {
            const ids = requests.get(fact.requestId);
            if (!ids) break;
            requests.delete(fact.requestId);
            const kind = fact.resolution.kind;
            await send(
              'approval.resolved',
              {
                resolution:
                  kind === 'allow' && metadata.automaticApproval
                    ? 'auto_approved'
                    : kind === 'allow' || kind === 'answer'
                    ? 'approved'
                    : kind === 'deny'
                    ? 'rejected'
                    : 'aborted',
                source:
                  kind === 'cancelled' || kind === 'interrupted' ? 'system' : metadata.resolutionSource ?? 'system',
                // A durable answer is permission, not evidence the tool body followed.
                executionFollowed: metadata.executionFollowed ?? false,
              },
              ids,
            );
            break;
          }
          case 'turn_ended': {
            const duration = Math.max(0, timestamp - (turns.get(fact.turnId) ?? timestamp));
            turns.delete(fact.turnId);
            if (fact.outcome !== 'completed')
              await send(
                'turn.error',
                {
                  errorCategory:
                    fact.outcome === 'cancelled' || fact.outcome === 'interrupted'
                      ? 'aborted'
                      : fact.error?.kind === 'authentication'
                      ? 'authentication'
                      : fact.error?.kind === 'network'
                      ? 'network'
                      : fact.error?.kind === 'rate_limit'
                      ? 'rate_limited'
                      : 'provider',
                  safeMessage: (fact.error?.message ?? `Turn ${fact.outcome}`).slice(0, 500),
                  recoverable: fact.error?.retryable ?? false,
                },
                { turnId: fact.turnId },
              );
            await send(
              'turn.end',
              {
                terminalKind:
                  fact.outcome === 'completed' ? 'response' : fact.outcome === 'failed' ? 'failed' : 'stale',
                duration,
              },
              { turnId: fact.turnId },
            );
            break;
          }
          default:
            break;
        }
      } catch (error) {
        diagnostic('Accepted-fact hook observation failed', error);
      }
    },
    async end(reason = 'normal', at = Date.now()) {
      if (ended) return;
      if (startedAt !== undefined)
        await emit('session.end', { reason, sessionDuration: Math.max(0, at - startedAt) }, {}, at);
      ended = true;
      turns.clear();
      executions.clear();
      requests.clear();
      calls.clear();
      // App owns shared HookService shutdown after all live background work ends.
    },
  };
}
