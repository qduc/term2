import { bindTerm2ToolContext } from './tool-context.js';
import type { ConversationDeps } from './types.js';
/** Same-engine branches; only the owning Session can admit their physical events. */
import { startNestedTurn } from './harness.js';
import type { TurnEvent, TurnHandle, TurnId, TurnResult } from '../engine/index.js';
import type { ExecutionId, NestedRunRequest, NestedRunResult, ToolRegistry, Workspace } from '../tools/index.js';
import type { Item } from '../model/index.js';
import type { ModelRequestCost } from './recovery-budget.js';
import type { DirectBranchFact, DirectTurnFact, DirectHistoryFact, Fact } from './facts.js';
import type { DirectSubagentContext, DirectSubagentDriver } from './subagent.js';
import { replay } from './replay.js';

export type DirectNestedAuthority = {
  readonly request: NestedRunRequest;
  readonly workspace: Workspace;
  readonly tools: ToolRegistry;
  readonly role: string;
  readonly label: string;
  /** A launch failure legacy settles as a failed run (a background worktree pin). */
  readonly failure?: string;
  /** Formats the settled result for the completion notice (legacy's formatSubagentResult). */
  readonly report?: (result: NestedRunResult) => Promise<string>;
};
export type DirectNestedAuthorizer = (
  request: NestedRunRequest,
  parent: { readonly turnId: TurnId; readonly parentExecutionId: ExecutionId; readonly signal: AbortSignal },
) => DirectNestedAuthority | Promise<DirectNestedAuthority>;

/** Reuses startNestedTurn/startTurn; this adapter accepts, never drives its own model loop. */
export function createDirectBranchDriver(options: {
  readonly createDeps: (turnId: TurnId) => ConversationDeps;
  readonly parentTurnId: TurnId;
  readonly rootTurnId: TurnId;
  readonly authority: DirectNestedAuthority;
  readonly accept: (fact: DirectBranchFact) => void;
  /**
   * Commits a branch request's cost as a top-level `request_cost_recorded` fact (not a `branch_event`), so the
   * run tree's accounting and replay read root and branch costs the same way.
   */
  readonly acceptCost: (turnId: TurnId, record: ModelRequestCost) => void;
  readonly factFor: (
    turnId: TurnId,
    event: Exclude<TurnEvent, { type: 'turn_ended' }>,
  ) => DirectTurnFact | DirectHistoryFact | null;
  readonly handles: Set<TurnHandle>;
  readonly publish?: (event: import('./facade-types.js').DirectBranchTransient) => void;
}): DirectSubagentDriver {
  return {
    async execute(request: NestedRunRequest, context: DirectSubagentContext): Promise<NestedRunResult> {
      // A continued run's branch is new; its ID carries the run's epoch.
      const branchId = context.task.epoch ? `${context.runId}#${context.task.epoch}` : context.runId;
      const turnId = `branch-${branchId}` as TurnId;
      context.signal.throwIfAborted();
      if (options.authority.failure !== undefined) throw new Error(options.authority.failure);
      const local: Fact[] = [{ type: 'turn_started', turnId, input: request.items }];
      options.accept({
        type: 'branch_started',
        branchId,
        taskId: context.task.taskId,
        turnId,
        parentTurnId: options.parentTurnId,
        rootTurnId: options.rootTurnId,
        input: request.items,
      });
      const deps = options.createDeps(turnId);
      if (!deps.toolContext) throw new Error('A branch requires an authorized workspace and settings');
      const handle = startNestedTurn(request, {
        turnId,
        affinity: { conversationKey: turnId, cacheKey: turnId, routingKey: turnId },
        deps: bindTerm2ToolContext({
          ...deps,
          tools: options.authority.tools,
          askOrchestrator: request.mode === 'background' ? context.askOrchestrator : undefined,
          toolContext: deps.toolContext ? { ...deps.toolContext, workspace: options.authority.workspace } : undefined,
          // Root context/steering/goal authority must not enter a nested request.
          takeSteering: undefined,
          prepareRequest: undefined,
          normalStop: undefined,
          continuity: undefined,
        }),
      });
      options.handles.add(handle);
      const cancel = () => handle.cancel();
      context.signal.addEventListener('abort', cancel, { once: true });
      if (context.signal.aborted) cancel();
      let terminal: TurnResult | undefined;
      let readFailure: unknown;
      const items: Item[] = [];
      // A child launched in the background never asks. A call that still needs an answer ends its run. Legacy
      // settles that as completed with an empty result, which hides the stop from the model: a confirmed legacy
      // bug (#136 item 11, accepted-differences). Next reports a failed run that names the call.
      let settledOnInteraction: { readonly kind: 'approval' | 'question'; readonly toolName: string } | undefined;
      const toolNames = new Map<string, string>();
      try {
        for await (const { token, event } of handle.events) {
          if (event.type === 'interaction_required' && request.mode === 'background') {
            settledOnInteraction ??= { kind: event.request.kind, toolName: event.request.toolName };
            handle.accept(token);
            handle.cancel();
            continue;
          }
          if (event.type === 'interaction_required') {
            context.observe({ kind: 'approval_requested' });
            try {
              const decision = context.interact(event.request);
              // interact synchronously appends the task-owned open before yielding.
              handle.accept(token);
              handle.answer(event.request.requestId, await decision);
            } catch {
              handle.cancel();
            }
            continue;
          }
          if (event.type === 'request_cost') {
            // Physical spend: recorded even after the branch is aborted, like any other cleanup outcome.
            options.acceptCost(turnId, event.record);
            handle.accept(token);
            continue;
          }
          if (event.type === 'budget_required') {
            // No parent/human extension is invented for a nested branch. The
            // accepted sensory event remains auditable; child stops cleanly.
            const fact: DirectTurnFact = { ...event, type: 'budget_opened' };
            options.accept({ type: 'branch_event', branchId, fact });
            local.push(fact);
            handle.accept(token);
            const closure: DirectTurnFact = {
              type: 'budget_closed',
              turnId,
              requestId: event.requestId,
              decision: { kind: 'stop' },
              source: 'system',
            };
            options.accept({ type: 'branch_event', branchId, fact: closure });
            local.push(closure);
            handle.answerBudget(event.requestId, { kind: 'stop' });
            continue;
          }
          if (event.type === 'turn_ended') {
            terminal = event.result;
            const repairs = replay(local, { recoverQueue: false }).recoveryFacts.filter(
              (fact) => fact.type !== 'turn_ended',
            );
            for (const repair of repairs) {
              if (repair.type !== 'item' && repair.type !== 'budget_closed')
                throw new Error('Unexpected branch recovery fact');
              options.accept({ type: 'branch_event', branchId, fact: repair });
              local.push(repair);
            }
            const fact: DirectTurnFact = {
              type: 'turn_ended',
              turnId,
              outcome: event.result.kind,
              ...(event.result.kind === 'failed' ? { error: event.result.error } : {}),
              ...(event.result.kind === 'interrupted' ? { terminalCause: event.result.terminalCause } : {}),
              ...('notice' in event.result && event.result.notice ? { notice: event.result.notice } : {}),
            };
            options.accept({ type: 'branch_event', branchId, fact });
            local.push(fact);
            handle.accept(token);
            continue;
          }
          if (
            context.signal.aborted &&
            event.type !== 'tool_execution_finished' &&
            event.type !== 'compaction_completed' &&
            event.type !== 'compaction_failed' &&
            !(event.type === 'item' && event.item.type === 'tool_result')
          )
            continue;
          if (event.type === 'tool_call_streaming_delta')
            options.publish?.({
              ...event,
              branchId,
              taskId: context.task.taskId,
              parentTurnId: options.parentTurnId,
              rootTurnId: options.rootTurnId,
            });
          // Legacy's activity tracker (subagent-async-registry): what the manager's "Last activity" row names.
          if (event.type === 'tool_call_streaming_delta')
            context.observe({
              kind: 'tool_input_received',
              toolName: event.toolName ?? 'tool',
              argumentCharCount: event.argumentCharCount,
            });
          else if (event.type === 'model_retrying')
            context.observe({ kind: 'retrying', attempt: event.attempt, maxRetries: event.maxRetries });
          else if (event.type === 'tool_called') context.observe({ kind: 'tool_started', toolName: event.toolName });
          else if (event.type === 'item' && event.item.type === 'tool_call')
            toolNames.set(event.item.callId, event.item.toolName);
          else if (event.type === 'item' && event.item.type === 'tool_result') {
            // Every call's result, including one the engine answered without running (an unknown tool).
            const toolName = toolNames.get(event.item.callId);
            context.observe({ kind: 'tool_completed', ...(toolName ? { toolName } : {}) });
          }
          if (event.type === 'tool_progress' || event.type === 'text_delta')
            context.progress(
              event.type === 'text_delta' ? event.delta : event.chunk,
              event.type === 'text_delta' ? 'text' : 'tool_progress',
              event.type === 'tool_progress' ? event.executionId : undefined,
            );
          const fact = options.factFor(turnId, event);
          if (fact) {
            if (
              fact.type === 'turn_started' ||
              fact.type === 'interaction_opened' ||
              fact.type === 'interaction_closed'
            )
              throw new Error('Branch interaction authority belongs to task facts');
            options.accept({
              type: 'branch_event',
              branchId,
              fact: fact.type === 'history_replaced' ? { ...fact, turnId } : fact,
            });
            local.push(fact);
            if (fact.type === 'item') items.push(fact.item);
          }
          handle.accept(token);
        }
      } catch (error) {
        readFailure = error;
        handle.cancel();
      } finally {
        context.signal.removeEventListener('abort', cancel);
        options.handles.delete(handle);
      }
      if (readFailure) throw readFailure;
      if (!terminal) throw new Error('Nested engine ended without accepted terminal');
      // Replay materializes canonical partial text as well as complete items.
      const produced = replay(local, { recoverQueue: false }).history.slice(request.items.length);
      let outcome: NestedRunResult['outcome'];
      if (terminal.kind === 'interrupted') {
        const cause = terminal.terminalCause;
        outcome =
          cause === 'budget_exhausted'
            ? { kind: 'budget_exhausted' }
            : { kind: 'interrupted', ...(cause !== undefined ? { terminalCause: cause } : {}) };
      } else outcome = terminal;
      if (settledOnInteraction) outcome = { kind: 'failed', error: backgroundInteractionError(settledOnInteraction) };
      // Accepted physical starts, including scripted leaves, are execution
      // evidence. Provider call names and offered declarations are not usage.
      const counts = new Map<string, number>();
      for (const fact of local) {
        if (fact.type !== 'tool_started') continue;
        counts.set(fact.toolName, (counts.get(fact.toolName) ?? 0) + 1);
      }
      const toolUseCounts = [...counts].map(([toolName, count]) => ({ toolName, count }));
      const result: NestedRunResult = { items: produced, outcome, toolsUsed: [...counts.keys()], toolUseCounts };
      const report = await options.authority.report?.({ ...result, runId: context.runId });
      return report === undefined ? result : { ...result, report };
    },
  };
}

/** Why a background run stopped: it can't ask the user, and a call needed an answer. */
function backgroundInteractionError(stop: { readonly kind: 'approval' | 'question'; readonly toolName: string }) {
  const need = stop.kind === 'approval' ? `${stop.toolName} needed approval` : `${stop.toolName} asked a question`;
  return {
    kind: 'invalid_request' as const,
    message: `${need}; a background run can't ask`,
    retryable: false,
  };
}
