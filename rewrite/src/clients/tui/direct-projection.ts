import type {
  WireInteraction,
  WireMessage,
  WireSnapshot,
  WireSubmissionRecord,
  WireTool,
  WireUsage,
} from '../../protocol/direct-wire.js';
import { historyReplacedMessage } from '../../protocol/direct-reducer-nested.js';
import { type InteractionView, type Message, type TaskView, type ToolView, type TuiState } from './state.js';

const usageText = (usage: WireUsage): string =>
  `${usage.inputTokens} in / ${usage.outputTokens} out (${usage.cachedInputTokens} cached)`;
const modelText = (model: { readonly provider: string; readonly model: string }): string =>
  `${model.provider}/${model.model}`;
/** Derive only from explicit provenance and the exact accepted injected content. */
function skillPresentation(record: WireSubmissionRecord | undefined) {
  const skill = record?.origin?.kind === 'tui' ? record.origin.skill : undefined;
  if (!record || !skill) return undefined;
  const originalTexts = record.originalContent.filter((part) => part.type === 'text');
  const currentTexts = record.content.filter((part) => part.type === 'text');
  if (originalTexts.length !== 1 || currentTexts.length !== 1) return undefined;
  const original = originalTexts[0]!;
  const current = currentTexts[0]!;
  const suffix = skill.request ? `\n\n${skill.request}` : '';
  if (suffix && !original.text.endsWith(suffix)) return undefined;
  const prefix = suffix ? original.text.slice(0, -suffix.length) : original.text;
  if (current.text !== prefix && !current.text.startsWith(`${prefix}\n\n`)) return undefined;
  const request = current.text === prefix ? '' : current.text.slice(prefix.length + 2);
  return {
    name: skill.name,
    prefix,
    request,
    display: `[Skill: ${skill.name}]${request.trim() ? `\n${request}` : ''}`,
  };
}
/** Wire objects are immutable once accepted, so a projection can be reused until the reducer replaces it. */
const cached = <K extends object, V>(build: (key: K) => V): ((key: K) => V) => {
  const views = new WeakMap<K, V>();
  return (key) => {
    let view = views.get(key);
    if (view === undefined) views.set(key, (view = build(key)));
    return view;
  };
};
const messageView = cached(
  (message: WireMessage): Message => ({
    id: message.id,
    turnId: message.turnId,
    role: message.role,
    ...(message.presentation ? { presentation: structuredClone(message.presentation) } : {}),
    text: message.content.length
      ? message.content
          .map((part) =>
            part.type === 'text' ? part.text : message.role === 'user' ? '' : `[image: ${part.mediaType}]`,
          )
          .join('')
      : message.text,
    error: message.isError,
    ...(message.replacesDraftId ? { replacesDraftId: message.replacesDraftId } : {}),
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
  }),
);
const toolView = cached(
  (tool: WireTool): ToolView => ({
    id: tool.executionId,
    turnId: tool.turnId,
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
  }),
);
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

const shallowEqual = (a: object, b: object): boolean => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => (a as never)[k] === (b as never)[k]);
};
const lastLists = new Map<string, { messages: readonly Message[]; tools: readonly ToolView[]; timeline: unknown }>();
/** Keep a list's identity when nothing in it changed, so memoised consumers skip per-token history scans. */
const sameList = <T>(previous: readonly T[] | undefined, next: readonly T[], equal: (a: T, b: T) => boolean) =>
  previous && previous.length === next.length && next.every((item, i) => equal(previous[i]!, item)) ? previous : next;

/** Project the direct wire snapshot at the host's attachment cut. */
/** Legacy prints nothing after a rewind or a compaction beyond the command's own lines. */
const SILENT_REPLACEMENTS = new Set([historyReplacedMessage('rewind'), historyReplacedMessage('compaction')]);

const shownAt = new Map<string, { tick: number; waiting: Set<string>; held: Set<string>; at: Map<string, number> }>();
/**
 * Legacy appends a call's row when it starts. A call that waits on the user (a question or an approval) starts only
 * once every decision pending in its batch is made, so until then it has no entry here.
 */
function toolShownAt(snapshot: WireSnapshot): ReadonlyMap<string, number> {
  const memory = shownAt.get(snapshot.sessionId) ?? {
    tick: 0,
    waiting: new Set<string>(),
    held: new Set<string>(),
    at: new Map<string, number>(),
  };
  shownAt.set(snapshot.sessionId, memory);
  memory.tick += 1;
  const waiting = new Set(snapshot.pendingInteractions.flatMap((request) => request.executionId ?? []));
  for (const id of memory.waiting) if (!waiting.has(id)) memory.held.add(id);
  for (const id of [...waiting, ...memory.held]) memory.at.delete(id);
  if (!waiting.size) {
    for (const id of memory.held) memory.at.set(id, memory.tick);
    memory.held.clear();
  }
  for (const tool of snapshot.tools)
    if (!memory.at.has(tool.executionId) && !waiting.has(tool.executionId) && !memory.held.has(tool.executionId))
      memory.at.set(tool.executionId, memory.tick);
  memory.waiting = waiting;
  return memory.at;
}

export function projectSnapshot(snapshot: WireSnapshot): TuiState {
  const drafts: Record<string, string> = {};
  const messages: Message[] = [];
  for (const message of snapshot.messages) {
    // The engine finalizes interrupted stream text with this deterministic ID before admitting a steer.
    // Keep the marker in the projection so it survives replay without changing stored message text.
    const live =
      snapshot.activeTurnId !== null && (message.turnId === undefined || message.turnId === snapshot.activeTurnId);
    const interrupted =
      !(message.draft && live) &&
      message.role === 'assistant' &&
      message.turnId !== undefined &&
      message.modelStep !== undefined &&
      message.id === `${message.turnId}-model-${message.modelStep}-partial`;
    const view = { ...messageView(message), ...(interrupted ? { interrupted: true } : {}) };
    const skill = skillPresentation(snapshot.submissions?.find((entry) => entry.messageId === message.id));
    if (message.role === 'user' && skill) {
      view.text = skill.display;
      view.historyText = `/skills ${skill.name}${skill.request ? ` ${skill.request}` : ''}`;
    }
    // Only the active turn's partial text is a live draft. A cancelled turn's partial reply never gets a final
    // message; it stays where it was said, in the timeline, instead of sinking below every later message.
    if (message.draft && message.role === 'assistant' && live && !interrupted) drafts[message.id] = view.text;
    else messages.push(view);
  }
  const before = lastLists.get(snapshot.sessionId);
  const stableMessages = sameList(before?.messages, messages, shallowEqual) as Message[];
  const stableTools = sameList(before?.tools, snapshot.tools.map(toolView), (a, b) => a === b) as ToolView[];
  const stableTimeline = (
    snapshot.timeline
      ? sameList(before?.timeline as typeof snapshot.timeline | undefined, snapshot.timeline, shallowEqual)
      : snapshot.timeline
  ) as typeof snapshot.timeline;
  lastLists.set(snapshot.sessionId, { messages: stableMessages, tools: stableTools, timeline: stableTimeline });
  return {
    sessionId: snapshot.sessionId,
    status: snapshot.status,
    activeTurnId: snapshot.activeTurnId,
    terminalOutcome: snapshot.terminal?.outcome,
    model: modelText(snapshot.model),
    messages: stableMessages,
    timeline: stableTimeline,
    drafts,
    // Reasoning is live turn activity, not a settled transcript message.
    reasoning: snapshot.activeTurnId && snapshot.reasoning ? { [snapshot.activeTurnId]: snapshot.reasoning } : {},
    tools: stableTools,
    toolShownAt: toolShownAt(snapshot),
    unmatchedTools: snapshot.unmatchedToolResults ?? [],
    budgets: snapshot.pendingBudgets ?? [],
    commands: snapshot.commands ?? [],
    interactions: snapshot.pendingInteractions.map(interactionView),
    queue: snapshot.queue.map((entry) => {
      const skill = skillPresentation(snapshot.submissions?.find((item) => item.messageId === entry.messageId));
      return {
        id: entry.messageId,
        text: entry.text,
        delivery: entry.delivery,
        content: entry.content,
        ...(skill ? { displayText: skill.display, skillEdit: { prefix: skill.prefix, request: skill.request } } : {}),
      };
    }),
    queueState: snapshot.queueState,
    queuePauseReason: snapshot.queuePauseReason,
    tasks: snapshot.tasks.map(taskView),
    notices: [
      // A history edit already reads as a sentence; the raw kind label is internal.
      ...snapshot.notices
        .filter(
          (notice) =>
            !(notice.kind === 'history_replaced' && SILENT_REPLACEMENTS.has(notice.message)) &&
            // Legacy loads memory into context without a line on screen.
            notice.kind !== 'memory_global_snapshot',
        )
        .map((notice) => (notice.kind === 'history_replaced' ? notice.message : `${notice.kind}: ${notice.message}`)),
      ...(snapshot.terminal?.notice ? [snapshot.terminal.notice] : []),
    ],
    usage: usageText(snapshot.usage),
    codexQuota: snapshot.codexQuota,
    speed: snapshot.lastSpeed,
    lastUsage: snapshot.lastUsage,
    cost: snapshot.cost ? `${snapshot.cost.currency} ${snapshot.cost.totalUsd.toFixed(4)}` : undefined,
    goal: snapshot.goal ? `${snapshot.goal.status}: ${snapshot.goal.text}` : undefined,
    verification: snapshot.verification
      ? `${snapshot.verification.status}${snapshot.verification.message ? `: ${snapshot.verification.message}` : ''}`
      : undefined,
    // A failed /compact is reported once, by its 'Context compaction failed:' line, as in legacy.
    lastError: (snapshot.commands ?? []).some(
      (receipt) =>
        receipt.request.operation.kind === 'compact' &&
        receipt.outcome?.kind === 'rejected' &&
        receipt.outcome.message === snapshot.lastError?.message,
    )
      ? undefined
      : snapshot.lastError?.message,
    canRetry: snapshot.retryEligibility.turn,
  };
}
