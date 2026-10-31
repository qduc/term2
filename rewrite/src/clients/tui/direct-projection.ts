import type { WireEvent, WireInteraction, WireMessage, WireSnapshot, WireTool, WireUsage } from '../../protocol/direct-wire.js';
import { updateView, type InteractionView, type Message, type TaskView, type ToolView, type TuiState } from './state.js';

const usageText = (usage: WireUsage): string => `${usage.inputTokens} in / ${usage.outputTokens} out (${usage.cachedInputTokens} cached)`;
const modelText = (model: { readonly provider: string; readonly model: string }): string => `${model.provider}/${model.model}`;
const messageView = (message: WireMessage): Message => ({
  id: message.id,
  role: message.role,
  text: message.content.length ? message.content.map(part => part.type === 'text' ? part.text : `[image: ${part.mediaType}]`).join('') : message.text,
  error: message.isError,
});
const toolView = (tool: WireTool): ToolView => ({
  id: tool.executionId,
  name: tool.toolName,
  status: tool.status === 'called' ? 'pending' : tool.status === 'started' ? 'running' : tool.isError || tool.status === 'unknown' ? 'failed' : 'completed',
  detail: tool.output ?? tool.progress,
  parent: tool.parentExecutionId,
});
const taskView = (task: WireSnapshot['tasks'][number]): TaskView => ({
  id: task.id, label: task.role ?? task.agentId ?? task.id, status: task.status, detail: task.text,
});

function interactionView(interaction: WireInteraction): InteractionView {
  return {
    id: interaction.requestId,
    kind: interaction.kind,
    title: interaction.summary || interaction.toolName,
    detail: [interaction.detail, interaction.risk && `Risk: ${interaction.risk}`, JSON.stringify(interaction.input, null, 2)].filter(Boolean).join('\n'),
    owner: interaction.parentExecutionId ?? interaction.turnId,
    choices: interaction.kind === 'approval'
      ? [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny (optional reason)' }]
      : [{ id: 'answer', label: 'Answer (text required)' }, { id: 'stop', label: 'Stop after resolving question' }],
    acceptsText: true,
  };
}

/** Project the direct wire snapshot at the host's attachment cut. */
export function projectSnapshot(snapshot: WireSnapshot): TuiState {
  const drafts: Record<string, string> = {};
  const messages: Message[] = [];
  for (const message of snapshot.messages) {
    const view = messageView(message);
    if (message.draft && message.role === 'assistant') drafts[message.id] = view.text;
    else messages.push(view);
  }
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    model: modelText(snapshot.model),
    messages,
    drafts,
    reasoning: snapshot.reasoning ? { [snapshot.activeTurnId ?? 'snapshot']: snapshot.reasoning } : {},
    tools: snapshot.tools.map(toolView),
    interactions: snapshot.pendingInteractions.map(interactionView),
    queue: snapshot.queue.map(entry => ({ id: entry.messageId, text: entry.text, delivery: entry.delivery })),
    queueState: snapshot.queueState,
    tasks: snapshot.tasks.map(taskView),
    notices: snapshot.notices.map(notice => `${notice.kind}: ${notice.message}`),
    usage: usageText(snapshot.usage),
    cost: snapshot.cost ? `${snapshot.cost.currency} ${snapshot.cost.totalUsd.toFixed(4)}` : undefined,
    goal: snapshot.goal ? `${snapshot.goal.status}: ${snapshot.goal.text}` : undefined,
    verification: snapshot.verification ? `${snapshot.verification.status}${snapshot.verification.message ? `: ${snapshot.verification.message}` : ''}` : undefined,
    lastError: snapshot.lastError?.message,
    canRetry: snapshot.retryEligibility.turn,
  };
}

/** Fold one typed direct wire event into client display state, in delivery order. */
export function projectEvent(state: TuiState, event: WireEvent): TuiState {
  if (event.sessionId !== state.sessionId) return state;
  switch (event.type) {
    case 'snapshot': return projectSnapshot(event.payload.snapshot);
    case 'turn_started': return event.payload.input.reduce((current, message) => updateView(current, { type: 'message', message: messageView(message) }), state);
    case 'text_delta': return updateView(state, { type: 'draft', id: event.payload.messageId, delta: event.payload.delta });
    case 'reasoning_delta': return updateView(state, { type: 'draft', id: event.turnId ?? 'snapshot', delta: event.payload.delta, reasoning: true });
    case 'message': {
      const message = event.payload.message;
      if (message.draft && message.role === 'assistant') {
        return { ...state, drafts: { ...state.drafts, [message.id]: messageView(message).text } };
      }
      return updateView(state, { type: 'message', message: messageView(message), replacesDraft: event.payload.replacesDraftId });
    }
    case 'tool_called':
    case 'tool_started': return updateView(state, { type: 'tool', tool: toolView(event.payload.tool) });
    case 'tool_progress': {
      const tool = state.tools.find(item => item.id === event.payload.executionId);
      return tool ? updateView(state, { type: 'tool', tool: { ...tool, detail: (tool.detail ?? '') + event.payload.chunk } }) : state;
    }
    case 'tool_finished': {
      const tool = state.tools.find(item => item.id === event.payload.executionId);
      return updateView(state, { type: 'tool', tool: { id: event.payload.executionId, name: tool?.name ?? event.payload.executionId, parent: tool?.parent, status: event.payload.isError ? 'failed' : 'completed', detail: event.payload.output } });
    }
    case 'interaction_opened': return updateView(state, { type: 'interaction', interaction: interactionView(event.payload.interaction) });
    case 'interaction_resolved': return updateView(state, { type: 'interaction_resolved', id: event.payload.requestId });
    case 'usage': return { ...state, usage: usageText(event.payload.usage) };
    case 'status_changed': return { ...state, status: event.payload.status };
    case 'turn_ended': return event.payload.error ? { ...state, lastError: event.payload.error.message } : state;
    case 'retrying': return updateView(state, { type: 'notice', notice: `Retry ${event.payload.attempt} in ${event.payload.delayMs}ms: ${event.payload.error.message}` });
    case 'retry_eligibility': return { ...state, canRetry: event.payload.turn };
    case 'configuration': return event.payload.model ? { ...state, model: modelText(event.payload.model) } : state;
    case 'queue_changed': return { ...state, queueState: event.payload.state, queue: event.payload.entries.map(entry => ({ id: entry.messageId, text: entry.text, delivery: entry.delivery })) };
    case 'task_changed': {
      const task = taskView(event.payload.task);
      const tasks = state.tasks.filter(item => item.id !== task.id);
      return { ...state, tasks: [...tasks, task] };
    }
    case 'subagent': return projectEvent(state, event.payload.event);
    case 'compacted': return updateView(state, { type: 'notice', notice: `Compacted ${event.payload.replaced} items.` });
    case 'cost': return { ...state, cost: `${event.payload.currency} ${event.payload.totalUsd.toFixed(4)}` };
    case 'notice': return updateView(state, { type: 'notice', notice: `${event.payload.kind}: ${event.payload.message}` });
    case 'goal': return { ...state, goal: event.payload.goal ? `${event.payload.goal.status}: ${event.payload.goal.text}` : undefined };
    case 'verification': return { ...state, verification: event.payload.verification ? `${event.payload.verification.status}${event.payload.verification.message ? `: ${event.payload.verification.message}` : ''}` : undefined };
    case 'error': return { ...state, lastError: event.payload.error.message };
  }
}
