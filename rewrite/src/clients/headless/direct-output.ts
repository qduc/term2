/** Stateful presentation of one headless run. Owns legacy JSON ordering and
 * streamed/final text reconciliation, never admission, cancellation or task life.
 */
import type { WireBudgetEvidence, WireEvent } from '../../protocol/direct-wire.js';
import { retryLine, toolStartLine } from './format.js';
import {
  formatGoalClosedByCheck,
  legacyCommandMessages,
  legacyFinalResponse,
  legacyReasoningDelta,
  legacyRequestCostUpdate,
  legacyRetry,
  legacyRunBudget,
  legacyAcceptedUsage,
  legacyTextDelta,
  legacyToolDispatched,
  legacyToolStarted,
  legacyToolCallStreamingDelta,
  legacyUsageUpdate,
} from '../../protocol/direct-json.js';
import type { DirectHeadlessOptions, HeadlessIo } from './types.js';

const RECOVERABLE_ERROR_KINDS = new Set([
  'context_overflow',
  'request_input_limit',
  'context_compaction_hard_fit',
  'provider_context_overflow',
  'context_paused',
]);

/** Create one presenter per connection run. Its terminal method refuses a
 * missing accepted final window rather than emitting a partial legacy final.
 */
export function createHeadlessOutput(options: DirectHeadlessOptions, sessionId: string) {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const output = options.output ?? 'plain';
  const quiet = options.quiet ?? false;
  const reportedErrors = new Set<string>();
  const emittedCommandMessageIds = new Set<string>();
  const legacyRequestIds = new Map<string, string>();
  let nextLegacyRequestId = 0;
  const legacyRequestId = (nativeId: string): string => {
    const existing = legacyRequestIds.get(nativeId);
    if (existing !== undefined) return existing;
    const assigned = `req-${++nextLegacyRequestId}`;
    legacyRequestIds.set(nativeId, assigned);
    return assigned;
  };
  const pendingUsageUpdates: ReturnType<typeof legacyUsageUpdate>[] = [];
  const pendingLegacyToolStarts = new Map<string, Extract<WireEvent, { readonly type: 'tool_called' }>>();
  let finalText = '';
  let streamedText = '';
  let completedText = '';
  /** Per-message streamed length, so a completed message writes only its missing suffix. */
  const streamedByMessage = new Map<string, number>();
  /** Exact text observed from this message's first delta in the current target turn. */
  const streamedTextByMessage = new Map<string, string>();
  const json = (record: unknown): void => {
    io.stdout.write(`${JSON.stringify(record)}\n`);
  };
  if (output === 'json')
    json({
      type: 'session_start',
      ...(options.profileMetadata ?? {}),
    });

  const errorText = (message: string, code?: string): void => {
    if (output === 'json') {
      json({ type: 'error', message, error: message, ...(code === undefined ? {} : { code }) });
      return;
    }
    if (reportedErrors.has(message)) return;
    reportedErrors.add(message);
    io.stderr.write(`error ${message}\n`);
  };

  const reportBudgetPause = (evidence?: WireBudgetEvidence): void => {
    // Session disposal currently closes the pending budget as a system stop.
    // Do not promise an interactive review that does not exist.
    const recovery = `Run budget paused. Work and completed results are retained, but this one-shot run cannot leave the budget request open: exiting closes it as a system stop. Resume with --resume ${sessionId} to inspect the stopped turn; budget review and extension are not available in headless. --auto-approve only approves tools.`;
    if (output === 'json') {
      json({
        type: 'run_budget_paused',
        code: 'run_budget_paused',
        sessionId,
        ...(evidence === undefined ? {} : { evidence }),
        recovery,
      });
    } else {
      io.stderr.write(`${recovery}\n`);
    }
  };
  return {
    get finalText() {
      return finalText;
    },
    errorText,
    reportBudgetPause,
    budgetEvidence(evidence: WireBudgetEvidence): void {
      if (output === 'json') json(legacyRunBudget(evidence));
    },
    resetTurn(): void {
      finalText = '';
      streamedText = '';
      streamedByMessage.clear();
    },
    completeTurn(): void {
      // JSON takes the accepted final window; plain keeps streamed/last-message behavior.
      if (output !== 'json') completedText = finalText || streamedText || completedText;
    },
    finish(): string {
      if (output === 'plain') io.stdout.write('\n');
      else json({ type: 'completed', finalText: completedText });
      return completedText;
    },
    event(event: WireEvent, targetTurnId: string | null): void {
      if (event.type === 'goal') {
        const { goal, source } = event.payload;
        if (source === 'goal_check' && goal?.status === 'achieved') {
          io.stderr.write(
            `${formatGoalClosedByCheck({
              id: goal.id,
              outcome: goal.text,
              status: 'achieved',
              ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
            })}\n`,
          );
        }
        return;
      }
      const forTurn = event.turnId === targetTurnId;
      switch (event.type) {
        case 'text_delta':
          if (!forTurn) break;
          streamedByMessage.set(
            event.payload.messageId,
            (streamedByMessage.get(event.payload.messageId) ?? 0) + event.payload.delta.length,
          );
          streamedText += event.payload.delta;
          {
            const fullText = (streamedTextByMessage.get(event.payload.messageId) ?? '') + event.payload.delta;
            streamedTextByMessage.set(event.payload.messageId, fullText);
            if (output === 'plain') io.stdout.write(event.payload.delta);
            else json(legacyTextDelta(event, fullText));
          }
          break;
        case 'reasoning_delta':
          if (!forTurn) break;
          if (output === 'json') json(legacyReasoningDelta(event));
          else if (options.showReasoning === true) io.stderr.write(event.payload.delta);
          break;
        case 'tool_call_streaming_delta':
          if (forTurn && output === 'json') json(legacyToolCallStreamingDelta(event));
          break;
        case 'request_cost_recorded':
          if (
            output === 'json' &&
            (event.payload.turnId === targetTurnId || event.payload.rootTurnId === targetTurnId)
          ) {
            json(legacyRequestCostUpdate(event, legacyRequestId(event.payload.record.requestId)));
            if (event.payload.record.usage !== undefined) json(legacyUsageUpdate(event.payload.record.usage));
            // A usage fact for this settlement may have arrived first; publish it
            // now, at the live request boundary, together with the cost record.
            for (const usage of pendingUsageUpdates.splice(0)) json(usage);
          }
          break;
        case 'usage':
          if (forTurn && output === 'json') pendingUsageUpdates.push(legacyAcceptedUsage(event.payload.usage));
          break;
        case 'tool_finished':
          if (!forTurn || output !== 'json') break;
          {
            const pending = pendingLegacyToolStarts.get(event.payload.executionId);
            if (pending !== undefined) {
              pendingLegacyToolStarts.delete(event.payload.executionId);
              const record = legacyToolStarted(pending);
              if (record !== undefined) json(record);
            }
          }
          for (const message of legacyCommandMessages(event, {
            providerCallId: true,
            onSourceId: (id) => emittedCommandMessageIds.add(id),
          }))
            json(message);
          break;
        case 'message': {
          if (!forTurn) break;
          const message = event.payload.message;
          if (message.role !== 'assistant' || message.draft === true) break;
          finalText = message.text;
          const key = event.payload.replacesDraftId ?? message.id;
          const streamed = streamedByMessage.get(key) ?? 0;
          if (output === 'plain' && message.text.length > streamed) {
            io.stdout.write(message.text.slice(streamed));
          }
          streamedByMessage.set(key, Math.max(streamed, message.text.length));
          break;
        }
        case 'tool_called':
          // Announce root calls before approval/dispatch; run_code children are not root diagnostics.
          if (forTurn && output === 'plain' && !quiet && event.payload.tool.parentExecutionId === undefined)
            io.stderr.write(toolStartLine(event.payload.tool));
          // The old tool_started boundary was the dispatched call, after its settled
          // request cost. Hold the real planned-call DTO until the matching physical
          // start (or a result/terminal fallback); never synthesize or drop it.
          if (forTurn && output === 'json') pendingLegacyToolStarts.set(event.payload.tool.executionId, event);
          break;
        case 'tool_started':
          if (forTurn && output === 'json') {
            const pending = pendingLegacyToolStarts.get(event.payload.tool.executionId);
            if (pending !== undefined) {
              pendingLegacyToolStarts.delete(event.payload.tool.executionId);
              const record = legacyToolStarted(pending);
              if (record !== undefined) json(record);
            }
            const record = legacyToolDispatched(event);
            if (record !== undefined) json(record);
          }
          break;
        case 'retrying':
          if (forTurn && output === 'plain' && !quiet) io.stderr.write(retryLine(event.payload));
          if (forTurn && output === 'json') {
            const record = legacyRetry(event);
            if (record !== undefined) json(record);
          }
          break;
        case 'budget_observed':
          if (forTurn && output === 'json') json(legacyRunBudget(event.payload.evidence));
          break;
        case 'notice':
          if (forTurn && output === 'plain' && !quiet) {
            io.stderr.write(`[${event.payload.kind}] ${event.payload.message}\n`);
          }
          break;
        case 'subagent':
          if (forTurn) {
            renderNested(
              event.payload.agentId,
              event.payload.role,
              event.payload.event,
              output,
              io,
              reportedErrors,
              quiet,
            );
          }
          break;
        case 'error':
          reportEventError(reportedErrors, io, event.payload.error.message, output, event.payload.error.kind);
          break;
        default:
          break;
      }
    },
    /** Report a failed terminal, preserving resumable-context exit semantics. */
    failure(message: string, kind: string | undefined): ['failed' | 'context_paused', number] {
      const recoverable = kind !== undefined && RECOVERABLE_ERROR_KINDS.has(kind);
      if (!recoverable) {
        errorText(message, kind);
        return ['failed', 1];
      }
      const recovery = `Work is retained. Resume with --resume ${sessionId} after reviewing the context limit.`;
      if (output === 'json') {
        io.stdout.write(
          `${JSON.stringify({
            type: 'context_paused',
            error: message,
            code: kind,
            sessionId,
            recovery,
          })}\n`,
        );
      } else {
        io.stderr.write(`error ${message}\n${recovery}\n`);
      }
      return ['context_paused', 2];
    },
    blockedNotice(notice: string | undefined, terminalCause: string): void {
      if (notice === undefined) return;
      // Keep the accepted model answer and render the host's notice separately.
      if (output !== 'json' && terminalCause === 'completion_verification_blocked') io.stdout.write(`\n${notice}\n`);
      else io.stderr.write(`${notice}\n`);
    },
    endTurn(event: Extract<WireEvent, { type: 'turn_ended' }>): boolean {
      if (output === 'json') {
        for (const pending of pendingLegacyToolStarts.values()) {
          const record = legacyToolStarted(pending);
          if (record !== undefined) json(record);
        }
        pendingLegacyToolStarts.clear();
        for (const usage of pendingUsageUpdates.splice(0)) json(usage);
        const window = event.payload.finalWindow;
        if (window === undefined) {
          json({
            type: 'error',
            code: 'legacy_final_window_unavailable',
            message: 'Accepted terminal has no final window; refusing to emit a partial legacy --json final.',
            error: 'Accepted terminal has no final window; refusing to emit a partial legacy --json final.',
          });
          return false;
        }
        const finalRecord = legacyFinalResponse(window, emittedCommandMessageIds, legacyRequestId);
        json(finalRecord);
        if (event.payload.outcome === 'completed') completedText = finalRecord.finalText;
      }
      return true;
    },
  };
}

function reportEventError(
  reported: Set<string>,
  io: HeadlessIo,
  message: string,
  output: 'plain' | 'json',
  kind?: string,
): void {
  if (output === 'json') {
    io.stdout.write(
      `${JSON.stringify({ type: 'error', message, error: message, ...(kind === undefined ? {} : { kind }) })}\n`,
    );
    return;
  }
  if (reported.has(message)) return;
  reported.add(message);
  io.stderr.write(`error ${message}\n`);
}

/** Nested subagent lines keep the old stderr labels; everything else stays nested. */
function renderNested(
  agentId: string,
  role: string | undefined,
  event: WireEvent,
  output: 'plain' | 'json',
  io: HeadlessIo,
  reported: Set<string>,
  quiet: boolean,
): void {
  if (output === 'json' || quiet) return;
  const label = role === undefined ? '[subagent]' : `[subagent: ${role}]`;
  switch (event.type) {
    case 'tool_started':
      io.stderr.write(`${label} ${toolStartLine(event.payload.tool).replace(/^\[tool\]\s*/, '')}`);
      break;
    case 'retrying':
      io.stderr.write(retryLine(event.payload, agentId));
      break;
    case 'error':
      reportEventError(reported, io, event.payload.error.message, output);
      break;
    default:
      break;
  }
}
