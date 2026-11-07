import type { StreamedModelTurnEvent } from '../../model/streamed-model-turn.js';
import { type AgentStream } from '../agent-stream.js';
import { RunResponseRecorder } from './run-response-recorder.js';
import { EventQueue } from './run-segment-events.js';
import type { ModelExchange, ModelToolCall, RunContext, RunState } from './run-state.js';
import { type ToolInvocationContext } from './tool-invocation-context.js';
/** Settles one response's tool plan; decision waits resume that same plan rather than redispatch it. */
export class RunToolRound {
  constructor(
    private readonly recorder: RunResponseRecorder,
    private readonly waitForBudget: (context: RunContext) => Promise<boolean>,
    private readonly waitForDecision: (context: RunContext) => Promise<void>,
  ) {}
  /** Execute and settle one tool plan; approvals suspend this operation in place. */
  async execute(context: RunContext, response: ModelExchange, calls: readonly ModelToolCall[]): Promise<boolean> {
    let { state, stream, queue, options, toolContext } = context;
    if (response.criticalWrapUp) return true;
    if (!state.criticalWrapUpPending && calls.length > 0) {
      await this.#dispatchToolCalls(state, stream, queue, calls, toolContext);
    }
    if (state.toolExecution.terminateAfterExecution) return true;
    if (calls.length === 0) return false;
    while (state.pendingRunBudgetInteraction || state.toolExecution.pendingApprovals.length > 0) {
      if (await this.waitForBudget(context)) return true;
      ({ state, stream, queue, options, toolContext } = context);
      let answeredApproval = false;
      if (state.toolExecution.pendingApprovals.length > 0) {
        stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
        await this.waitForDecision(context);
        ({ state, stream, queue, options, toolContext } = context);
        if (state.approvalQueue?.length) {
          state.toolExecution.validateApprovalBatch(state.approvalQueue);
          const batch = state.approvalQueue.splice(0);
          for (const decision of batch)
            state.toolExecution.resolveApproval(
              { callId: decision.callId, interruption: decision.interruption },
              decision.decision,
              decision.message,
              state.approvals,
            );
          answeredApproval = true;
        } else if (state.approvalDecision) {
          state.toolExecution.resolveApproval(
            { callId: state.approvalDecisionCallId, interruption: state.approvalDecisionInterruption },
            state.approvalDecision,
            state.approvalMessage,
            state.approvals,
          );
          state.approvalDecision = undefined;
          state.approvalDecisionCallId = undefined;
          state.approvalDecisionInterruption = undefined;
          state.approvalMessage = undefined;
          answeredApproval = true;
        }
      }
      if (context.options.signal?.aborted) {
        throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
      }
      if (state.toolExecution.hasPlan) {
        await state.toolExecution.settle(this.recorder.toolContext(state, stream, queue, toolContext));
      }
      stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
      if (answeredApproval && options.stopAfterApprovalResolution && stream.interruptions.length === 0) return true;
      if (state.toolExecution.terminateAfterExecution) return true;
    }
    return false;
  }
  async #dispatchToolCalls(
    state: RunState,
    stream: AgentStream,
    queue: EventQueue,
    events: readonly Extract<StreamedModelTurnEvent, { type: 'tool_call' }>[],
    toolContext: ToolInvocationContext,
  ): Promise<void> {
    const context = this.recorder.toolContext(state, stream, queue, toolContext);
    await state.toolExecution.plan(events, context);
    stream.interruptions = state.toolExecution.pendingApprovals.map((item) => item.interruption);
    if (!state.pendingRunBudgetInteraction) await state.toolExecution.settle(context);
  }
}
