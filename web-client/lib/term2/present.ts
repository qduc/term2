/**
 * The only place a transcript rule is written: one snapshot of the shared fold (plus the answerable interaction
 * DTOs) becomes the view React renders. Pure: it reads only its arguments and never mutates them. Rules and their
 * numbers follow docs/plans/web-client/web-transcript-single-source-spec.md, section 2.5.
 *
 * Reuse: a turn whose inputs are the same objects as last time is returned as the same object, so one streaming
 * delta re-renders one turn.
 */
import type {
  WireBranchSnapshot,
  WireMessage,
  WireReasoningBlock,
  WireSnapshot,
  WireTask,
  WireTool,
  WireTurnResult,
  WireUsage,
} from './generated/wire-fold.js';
import type {
  InteractionProjection,
  Term2Command,
  Term2ConnectionStatus,
  Term2SessionView,
  Term2TurnItem,
  Term2TurnView,
} from './types';

/** The parts of a session snapshot the panels read, filled by present.ts; components never read the snapshot. */
export interface Term2SessionFacts {
  /** Each task with its subagent branch (steps, turns, usage) when it has one. */
  tasks: readonly (WireTask & {
    readonly branch: WireBranchSnapshot | null;
    /** The branch's turns, presented like the root's (the running-tasks panel's activity). */
    readonly branchTurns: readonly Term2TurnView[];
  })[];
  queue: WireSnapshot['queue'];
  queueState: WireSnapshot['queueState'];
  queuePauseReason: NonNullable<WireSnapshot['queuePauseReason']> | null;
  notifications: NonNullable<WireSnapshot['notifications']>;
  requestCosts: NonNullable<WireSnapshot['requestCosts']>;
  usage: WireSnapshot['usage'];
  lastUsage: NonNullable<WireSnapshot['lastUsage']> | null;
  cost: WireSnapshot['cost'];
  goal: WireSnapshot['goal'];
  verification: WireSnapshot['verification'];
  notices: WireSnapshot['notices'];
  /** Rule 13: a session-level fault, shown once instead of a live-only overlay. */
  lastError: WireSnapshot['lastError'];
  /** Rule 2: the snapshot has tools but no timeline, so no order can be shown. */
  unorderedTranscript: boolean;
  /** True once this logical session has rolled over to a successor backing log. */
  rolledOver: boolean;
}

/** The pending-interaction DTOs a frame carried, by request id (server-sse.ts, PendingInteractionEntry). */
export type PresentInteractions = ReadonlyMap<string, Exclude<InteractionProjection, null>>;

/** What the store knows that the snapshot does not: the connection. */
export type PresentConnection = {
  readonly phase: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'reload_required' | 'closed';
  readonly error: string | null;
  readonly replayMode?: 'atomic' | 'unavailable';
};

const TEXT_CAP = 100_000; // rule 14
const ERROR_MESSAGE_CAP = 4_096;
const COMMAND_ERROR_CAP = 10_000;
const COMPACTION_NOTICE = 'context_compaction';
const cap = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text);

/** Rule 7: the one table from a native error kind to the reason a failed turn shows (the server's errorReason). */
export function failureReason(kind: string | undefined): string {
  switch (kind) {
    case 'provider':
      return 'provider_error';
    case 'network':
      return 'network_error';
    case 'authentication':
      return 'authentication_error';
    case 'rate_limit':
      return 'rate_limit';
    case 'cancelled':
      return 'cancelled';
    case 'validation':
      return 'validation_error';
    case 'compaction':
      return 'compaction_failed';
    case 'retry_exhausted':
      return 'retry_exhausted';
    default:
      return 'runtime_error';
  }
}

type Entry = { readonly kind: 'message'; readonly message: WireMessage } | { readonly kind: 'tool'; readonly tool: WireTool };
type TurnInputs = {
  readonly entries: readonly Entry[];
  readonly result: WireTurnResult | undefined;
  readonly blocks: readonly WireReasoningBlock[];
  readonly usage: WireUsage | undefined;
  readonly active: boolean;
  /** The last turn of an interrupted session reads as aborted (rule 6). */
  readonly interruptedLast: boolean;
  /** Everything else the turn reads from the snapshot; an idle turn reads only its own terminal. */
  readonly live: readonly unknown[];
};
const memo = new WeakMap<Term2SessionView, ReadonlyMap<string, { inputs: TurnInputs; turn: Term2TurnView }>>();

const sameList = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sameInputs = (a: TurnInputs, b: TurnInputs) =>
  a.result === b.result &&
  a.usage === b.usage &&
  a.active === b.active &&
  a.interruptedLast === b.interruptedLast &&
  sameList(a.blocks, b.blocks) &&
  sameList(a.live, b.live) &&
  a.entries.length === b.entries.length &&
  a.entries.every((entry, index) => {
    const other = b.entries[index]!;
    return entry.kind === 'message'
      ? other.kind === 'message' && other.message === entry.message
      : other.kind === 'tool' && other.tool === entry.tool;
  });

/** Rule 1 and 2: turns are timeline entries grouped by turn, in timeline order. */
function groupEntries(snapshot: WireSnapshot): { readonly turns: Map<string, Entry[]>; readonly unordered: boolean } {
  const turns = new Map<string, Entry[]>();
  const add = (turnId: string | undefined, entry: Entry) => {
    if (!turnId) return;
    const list = turns.get(turnId);
    if (list) list.push(entry);
    else turns.set(turnId, [entry]);
  };
  const shown = (message: WireMessage | undefined): message is WireMessage =>
    message !== undefined && message.role !== 'tool' && message.presentation?.withdrawn !== true;
  if (snapshot.timeline === null) {
    if (snapshot.tools.length > 0) return { turns, unordered: true };
    for (const message of snapshot.messages) if (shown(message)) add(message.turnId, { kind: 'message', message });
    return { turns, unordered: false };
  }
  const messages = new Map(snapshot.messages.map((message) => [message.id, message]));
  const tools = new Map(snapshot.tools.map((tool) => [tool.executionId, tool]));
  for (const entry of snapshot.timeline) {
    if (entry.kind === 'message') {
      const message = messages.get(entry.id);
      if (shown(message)) add(message.turnId, { kind: 'message', message });
    } else {
      // A result with no call stays in unmatchedToolResults; it is not a card (rule 5).
      const tool = tools.get(entry.id);
      if (tool) add(tool.turnId, { kind: 'tool', tool });
    }
  }
  return { turns, unordered: false };
}

/** Rule 5: one command per execution. */
function command(tool: WireTool, result: WireTurnResult | undefined): Term2Command {
  const input = tool.input;
  const argumentsText = typeof input === 'string' ? input : input === undefined ? undefined : JSON.stringify(input);
  const status: Term2Command['status'] =
    tool.status === 'completed'
      ? tool.isError
        ? 'failed'
        : 'completed'
      : tool.status === 'called' || tool.status === 'started'
      ? !result
        ? tool.status === 'called'
          ? 'pending'
          : 'running'
        : result.outcome === 'failed'
        ? 'failed'
        : result.outcome === 'completed'
        ? 'unknown'
        : 'aborted'
      : 'unknown';
  const output = typeof tool.output === 'string' ? tool.output : undefined;
  return {
    callId: tool.executionId,
    toolName: tool.toolName,
    nativeTool: tool as unknown as Readonly<Record<string, unknown>>,
    status,
    ...(argumentsText !== undefined ? { argumentsText } : {}),
    ...(output !== undefined && !tool.isError ? { output: cap(output, TEXT_CAP) } : {}),
    ...(output !== undefined && tool.isError ? { error: cap(output, COMMAND_ERROR_CAP) } : {}),
  };
}

function presentTurn(turnId: string, inputs: TurnInputs, snapshot: WireSnapshot): Term2TurnView {
  const { entries, result, blocks, usage, active, interruptedLast } = inputs;
  // Rule 13: a runtime fault (Session interrupted with an error, no accepted terminal) is shown on the turn it
  // interrupted, as the turn's failure.
  const fault = !result && interruptedLast && snapshot.lastError ? snapshot.lastError : undefined;
  const items: Term2TurnItem[] = [];
  const commands: Term2Command[] = [];
  const texts: string[] = [];
  let userText: string | undefined;
  let userMessageId: string | undefined;
  let userContent: readonly unknown[] | undefined;
  // Where each block goes: after the item its anchor names, or first (rule 8).
  const itemIndexOf = new Map<string, number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'tool') {
      commands.push(command(entry.tool, result));
      items.push({ kind: 'tool', executionId: entry.tool.executionId });
      itemIndexOf.set(`tool:${entry.tool.executionId}`, items.length);
      continue;
    }
    const message = entry.message;
    if (message.role === 'user') {
      // Rule 3: the first user message, when nothing precedes it, is the opening bubble; later ones are steers.
      if (index === 0) {
        userText = cap(message.text, TEXT_CAP);
        userMessageId = message.id;
        userContent = message.content;
        itemIndexOf.set(`message:${message.id}`, 0);
      } else if (message.text.length > 0) {
        items.push({ kind: 'user', id: message.id, text: cap(message.text, TEXT_CAP), content: message.content });
        itemIndexOf.set(`message:${message.id}`, items.length);
      }
      continue;
    }
    if (message.text.length === 0) continue;
    // Rule 4.
    texts.push(message.text);
    items.push({
      kind: 'text',
      id: message.id,
      text: cap(message.text, TEXT_CAP),
      ...(message.draft ? { draft: true } : {}),
      ...(message.modelStep !== undefined ? { modelStep: message.modelStep } : {}),
    });
    itemIndexOf.set(`message:${message.id}`, items.length);
  }
  // Rule 8: accepted blocks after their anchors (inserting from the back keeps earlier positions valid).
  const placed = blocks
    .map((block, order) => ({
      block,
      order,
      at: block.after ? itemIndexOf.get(`${block.after.kind}:${block.after.id}`) ?? 0 : 0,
    }))
    .sort((a, b) => b.at - a.at || b.order - a.order);
  for (const { block, at } of placed)
    items.splice(at, 0, {
      kind: 'reasoning',
      id: block.messageId,
      text: cap(block.text, TEXT_CAP),
      ...(block.modelStep !== null ? { modelStep: block.modelStep } : {}),
    });
  const liveReasoning = active ? snapshot.liveReasoning ?? '' : '';
  if (active && (liveReasoning.length > 0 || (snapshot.thinking && blocks.length === 0))) {
    const liveItem: Term2TurnItem = {
      kind: 'reasoning',
      id: `live-reasoning:${turnId}`,
      text: cap(liveReasoning, TEXT_CAP),
      streaming: Boolean(snapshot.thinking),
    };
    // Live reasoning preceded the draft text of the same step; place it before a trailing draft so
    // accepting the reasoning block does not move it from below the reply to above it.
    const last = items.at(-1);
    if (last?.kind === 'text' && last.draft) items.splice(items.length - 1, 0, liveItem);
    else items.push(liveItem);
  }

  // Rule 6. A retried turn's outcome belongs to the turn that retried it, so its own failure or stop is not shown.
  const status: Term2TurnView['status'] = result
    ? result.outcome === 'completed' || result.retried
      ? 'completed'
      : result.outcome === 'failed'
      ? 'failed'
      : 'aborted'
    : active && (snapshot.status === 'running' || snapshot.status === 'awaiting_interaction')
    ? 'streaming'
    : interruptedLast
    ? fault
      ? 'failed'
      : 'aborted'
    : 'unknown';
  // Rule 7.
  const terminalError = snapshot.terminal?.turnId === turnId ? snapshot.terminal.error : undefined;
  const error = result?.retried ? undefined : result?.outcome === 'failed' ? result.error ?? terminalError : fault;
  // Rule 9: notes only from snapshot fields, while the turn is active.
  const transientStatus = active ? turnNote(snapshot) : undefined;

  return {
    turnId,
    role: 'assistant',
    ...(userText !== undefined ? { userText } : {}),
    ...(userMessageId !== undefined ? { userMessageId } : {}),
    ...(userContent !== undefined ? { userContent } : {}),
    text: cap(texts.join('\n\n'), TEXT_CAP),
    reasoning: cap(liveReasoning || blocks.at(-1)?.text || '', TEXT_CAP),
    status,
    commands,
    items,
    ...(transientStatus ? { transientStatus } : {}),
    // Rule 10: a turn with no usage entry shows nothing, not zero.
    ...(usage
      ? {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.inputTokens + usage.outputTokens,
          },
        }
      : {}),
    ...(result?.outcome === 'failed' || fault ? { error: failureReason(error?.kind) } : {}),
    ...(fault ? { interruptedByFault: true } : {}),
    ...(error?.message?.trim() ? { errorMessage: cap(error.message, ERROR_MESSAGE_CAP) } : {}),
  };
}

function lastTurnId(snapshot: WireSnapshot): string | undefined {
  for (let index = (snapshot.timeline ?? []).length - 1; index >= 0; index -= 1) {
    const entry = snapshot.timeline![index]!;
    const owner =
      entry.kind === 'message'
        ? snapshot.messages.find((message) => message.id === entry.id)?.turnId
        : snapshot.tools.find((tool) => tool.executionId === entry.id)?.turnId;
    if (owner) return owner;
  }
  return undefined;
}

function turnNote(snapshot: WireSnapshot): string | undefined {
  if (snapshot.retry) return `retrying (attempt ${snapshot.retry.attempt}/${snapshot.retry.maxRetries})`;
  const compaction = snapshot.notices.filter((notice) => notice.kind === COMPACTION_NOTICE).at(-1);
  if (compaction?.message === 'Compacting context...') return 'compacting context…';
  if (compaction?.message.startsWith('Context compaction failed')) return 'compaction failed';
  return undefined;
}

/** Rule 11: the session status; connection phases come from the store. */
function sessionStatus(
  snapshot: WireSnapshot | null,
  connection: PresentConnection,
  interaction: InteractionProjection,
): Term2ConnectionStatus {
  if (connection.phase === 'reload_required') return 'error';
  if (connection.phase === 'connecting' || !snapshot) return connection.phase === 'idle' ? 'idle' : 'connecting';
  if (connection.phase === 'reconnecting') return 'reconnecting';
  if (connection.phase === 'closed') return 'closed';
  if (interaction) return 'awaiting_interaction';
  return snapshot.status === 'idle' ? 'connected' : snapshot.status;
}

/** Rule 12: the DTO for the first pending request; a request with no DTO is shown as pending and not answerable. */
function presentedInteraction(snapshot: WireSnapshot, interactions: PresentInteractions): InteractionProjection {
  const request = snapshot.pendingInteractions[0] ?? snapshot.pendingBudgets?.[0];
  if (!request) return null;
  return interactions.get(request.requestId) ?? { state: 'unavailable', requestId: request.requestId, turnId: request.turnId };
}

type Branch = NonNullable<WireSnapshot['branches']>[number];
const branchMemo = new WeakMap<Branch, readonly Term2TurnView[]>();

/** A subagent branch's turns, with the same rules as the root's; a branch with no terminal yet is running. */
function branchTurns(root: WireSnapshot, branch: Branch): readonly Term2TurnView[] {
  const known = branchMemo.get(branch);
  if (known) return known;
  const scratch: WireSnapshot = {
    ...root,
    status: branch.terminal ? 'idle' : 'running',
    activeTurnId: branch.terminal ? null : branch.turnId,
    liveReasoning: undefined,
    thinking: false,
    retry: undefined,
    notices: [],
    messages: branch.messages,
    tools: branch.tools,
    timeline: branch.timeline,
    turnResults: branch.turnResults,
    terminal: branch.terminal,
    reasoningBlocks: [],
    turnUsage: [],
  };
  const results = new Map(branch.turnResults.map((result) => [result.turnId, result]));
  const turns = [...groupEntries(scratch).turns].map(([turnId, entries]) =>
    presentTurn(
      turnId,
      {
        entries,
        result: results.get(turnId),
        blocks: [],
        usage: undefined,
        active: scratch.activeTurnId === turnId,
        interruptedLast: false,
        live: [],
      },
      scratch,
    ),
  );
  branchMemo.set(branch, turns);
  return turns;
}

/** The slices of the snapshot the panels read; components never read the snapshot itself. */
function sessionFacts(snapshot: WireSnapshot): Term2SessionFacts {
  const branchesByTask = new Map<string, Branch>();
  for (const branch of snapshot.branches ?? []) branchesByTask.set(branch.taskId, branch);
  return {
    tasks: snapshot.tasks.map((task) => {
      const branch = branchesByTask.get(task.id) ?? null;
      return { ...task, branch, branchTurns: branch ? branchTurns(snapshot, branch) : [] };
    }),
    queue: snapshot.queue,
    queueState: snapshot.queueState,
    queuePauseReason: snapshot.queuePauseReason ?? null,
    notifications: snapshot.notifications ?? { notices: [], deliveries: [] },
    requestCosts: snapshot.requestCosts ?? [],
    usage: snapshot.usage,
    lastUsage: snapshot.lastUsage ?? null,
    cost: snapshot.cost,
    goal: snapshot.goal,
    verification: snapshot.verification,
    notices: snapshot.notices,
    lastError: snapshot.lastError,
    unorderedTranscript: false,
    rolledOver: snapshot.backingSessionId !== snapshot.sessionId,
  };
}

/**
 * The view for one snapshot. `previous` is the view this returned last time for the same session; unchanged turns
 * are reused from it.
 */
export function present(
  sessionId: string,
  snapshot: WireSnapshot | null,
  interactions: PresentInteractions,
  connection: PresentConnection,
  previous?: Term2SessionView,
): Term2SessionView {
  const base = {
    sessionId,
    status: 'idle' as Term2ConnectionStatus,
    error: connection.error,
    reloadRequired: connection.phase === 'reload_required',
    ...(connection.replayMode ? { replayMode: connection.replayMode } : {}),
  };
  if (!snapshot) {
    return { ...base, turns: [], pendingInteraction: null, lastAppliedSequence: 0, status: sessionStatus(null, connection, null) };
  }
  const pendingInteraction = presentedInteraction(snapshot, interactions);
  const { turns: grouped, unordered } = groupEntries(snapshot);
  const results = new Map((snapshot.turnResults ?? []).map((result) => [result.turnId, result]));
  const usageByTurn = new Map((snapshot.turnUsage ?? []).map((entry) => [entry.turnId, entry.usage]));
  const blocksByTurn = new Map<string, WireReasoningBlock[]>();
  for (const block of snapshot.reasoningBlocks ?? []) {
    if (!block.turnId) continue;
    const list = blocksByTurn.get(block.turnId);
    if (list) list.push(block);
    else blocksByTurn.set(block.turnId, [block]);
  }
  const live = [snapshot.liveReasoning, snapshot.thinking, snapshot.retry, snapshot.notices, snapshot.status, snapshot.terminal];
  const cache = previous?.sessionId === sessionId ? memo.get(previous) : undefined;
  const last = snapshot.status === 'interrupted' ? lastTurnId(snapshot) : undefined;
  const nextCache = new Map<string, { inputs: TurnInputs; turn: Term2TurnView }>();
  const turns: Term2TurnView[] = [];
  for (const [turnId, entries] of grouped) {
    const active = snapshot.activeTurnId === turnId;
    const inputs: TurnInputs = {
      entries,
      result: results.get(turnId),
      blocks: blocksByTurn.get(turnId) ?? [],
      usage: usageByTurn.get(turnId),
      active,
      interruptedLast: turnId === last,
      live: active
        ? live
        : [snapshot.terminal?.turnId === turnId ? snapshot.terminal : null, turnId === last ? snapshot.lastError : null],
    };
    const known = cache?.get(turnId);
    const turn = known && sameInputs(known.inputs, inputs) ? known.turn : presentTurn(turnId, inputs, snapshot);
    nextCache.set(turnId, { inputs, turn });
    turns.push(turn);
  }
  const view: Term2SessionView = {
    ...base,
    turns,
    pendingInteraction,
    status: sessionStatus(snapshot, connection, pendingInteraction),
    lastAppliedSequence: snapshot.seq ?? 0,
    session: { ...sessionFacts(snapshot), unorderedTranscript: unordered },
  };
  memo.set(view, nextCache);
  return view;
}
