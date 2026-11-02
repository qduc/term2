import type { WireInteraction, WireMessage, WireSnapshot, WireTool, WireUsage } from '../../protocol/direct-wire.js';
import { type InteractionView, type Message, type TaskView, type ToolView, type TuiState } from './state.js';

const usageText = (usage: WireUsage): string =>
  `${usage.inputTokens} in / ${usage.outputTokens} out (${usage.cachedInputTokens} cached)`;
const modelText = (model: { readonly provider: string; readonly model: string }): string =>
  `${model.provider}/${model.model}`;
const messageView = (message: WireMessage): Message => ({
  id: message.id,
  role: message.role,
  ...(message.presentation ? { presentation: structuredClone(message.presentation) } : {}),
  text: message.content.length
    ? message.content.map((part) => (part.type === 'text' ? part.text : `[image: ${part.mediaType}]`)).join('')
    : message.text,
  error: message.isError,
  ...(message.role === 'user'
    ? {
        historyText:
          message.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('') || message.text,
        attachments: message.content.filter((part) => part.type === 'image'),
      }
    : {}),
});
const toolView = (tool: WireTool): ToolView => ({
  id: tool.executionId,
  name: tool.toolName,
  status:
    tool.status === 'called'
      ? 'pending'
      : tool.status === 'started'
      ? 'running'
      : tool.isError || tool.status === 'unknown'
      ? 'failed'
      : 'completed',
  detail: tool.output ?? tool.progress,
  parent: tool.parentExecutionId,
  input: tool.input,
  display: tool.display,
  content: tool.content,
  outcomeUnknown: tool.status === 'unknown',
});
const taskView = (task: WireSnapshot['tasks'][number]): TaskView => ({
  id: task.id,
  label: task.label ?? task.name ?? task.role ?? task.agentId ?? task.id,
  status: task.status,
  detail: task.text,
  turnId: task.turnId,
  agentId: task.agentId,
  role: task.role,
  wire: task,
});

function interactionView(interaction: WireInteraction): InteractionView {
  return {
    id: interaction.requestId,
    kind: interaction.kind,
    title: interaction.summary || interaction.toolName,
    // Structured questions own their current page; raw args expose every page at once.
    detail:
      interaction.kind === 'question' && interaction.questions?.length
        ? undefined
        : [
            interaction.detail,
            interaction.risk && `Risk: ${interaction.risk}`,
            JSON.stringify(interaction.input, null, 2),
          ]
            .filter(Boolean)
            .join('\n'),
    owner: interaction.taskId ?? interaction.parentExecutionId ?? interaction.turnId,
    turnId: interaction.turnId,
    taskId: interaction.taskId,
    choices:
      interaction.kind === 'approval'
        ? [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny (optional reason)' },
            ...interaction.supportedGrants.map((grant) => ({ id: `grant:${grant}`, label: `Grant: ${grant}` })),
          ]
        : [
            { id: 'answer', label: 'Answer (text required)' },
            { id: 'stop', label: 'Stop after resolving question' },
          ],
    acceptsText: true,
    questions: interaction.questions,
    supportedGrants: interaction.supportedGrants,
  };
}

/** Project the direct wire snapshot at the host's attachment cut. */
export function projectSnapshot(snapshot: WireSnapshot): TuiState {
  const drafts: Record<string, string> = {};
  const messages: Message[] = [];
  for (const message of snapshot.messages) {
    // The engine finalizes interrupted stream text with this deterministic ID before admitting a steer.
    // Keep the marker in the projection so it survives replay without changing stored message text.
    const interrupted =
      message.role === 'assistant' &&
      message.turnId !== undefined &&
      message.modelStep !== undefined &&
      message.id === `${message.turnId}-model-${message.modelStep}-partial`;
    const view = { ...messageView(message), ...(interrupted ? { interrupted: true } : {}) };
    // Only the active turn's partial text is a live draft. A cancelled turn's partial reply never gets a final
    // message; it stays where it was said, in the timeline, instead of sinking below every later message.
    const live =
      snapshot.activeTurnId !== null && (message.turnId === undefined || message.turnId === snapshot.activeTurnId);
    if (message.draft && message.role === 'assistant' && live && !interrupted) drafts[message.id] = view.text;
    else messages.push(view);
  }
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    activeTurnId: snapshot.activeTurnId,
    model: modelText(snapshot.model),
    messages,
    timeline: snapshot.timeline,
    drafts,
    // Reasoning is live turn activity, not a settled transcript message.
    reasoning: snapshot.activeTurnId && snapshot.reasoning ? { [snapshot.activeTurnId]: snapshot.reasoning } : {},
    tools: snapshot.tools.map(toolView),
    unmatchedTools: snapshot.unmatchedToolResults ?? [],
    budgets: snapshot.pendingBudgets ?? [],
    commands: snapshot.commands ?? [],
    interactions: snapshot.pendingInteractions.map(interactionView),
    queue: snapshot.queue.map((entry) => ({
      id: entry.messageId,
      text: entry.text,
      delivery: entry.delivery,
      content: entry.content,
    })),
    queueState: snapshot.queueState,
    queuePauseReason: snapshot.queuePauseReason,
    tasks: snapshot.tasks.map(taskView),
    notices: [
      // A history edit already reads as a sentence; the raw kind label is internal.
      ...snapshot.notices.map((notice) =>
        notice.kind === 'history_replaced' ? notice.message : `${notice.kind}: ${notice.message}`,
      ),
      ...(snapshot.terminal?.notice ? [snapshot.terminal.notice] : []),
    ],
    usage: usageText(snapshot.usage),
    usageTotals: {
      inputTokens: snapshot.usage.inputTokens,
      outputTokens: snapshot.usage.outputTokens,
      cachedInputTokens: snapshot.usage.cachedInputTokens,
    },
    cost: snapshot.cost ? `${snapshot.cost.currency} ${snapshot.cost.totalUsd.toFixed(4)}` : undefined,
    goal: snapshot.goal ? `${snapshot.goal.status}: ${snapshot.goal.text}` : undefined,
    verification: snapshot.verification
      ? `${snapshot.verification.status}${snapshot.verification.message ? `: ${snapshot.verification.message}` : ''}`
      : undefined,
    lastError: snapshot.lastError?.message,
    canRetry: snapshot.retryEligibility.turn,
  };
}
