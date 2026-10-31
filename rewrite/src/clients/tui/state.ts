/** Client display state. This is a view model, not a wire or persistence format. */
export type Message = {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly text: string;
  readonly error?: boolean;
};

export type ToolView = {
  /** Execution occurrence identity, not a provider call ID. */
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'rejected';
  readonly detail?: string;
  readonly parent?: string;
};

export type InteractionView = {
  readonly id: string;
  readonly kind: 'approval' | 'question';
  readonly title: string;
  readonly detail?: string;
  readonly owner?: string;
  /** Only choices actually offered by the protocol may be rendered. */
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly acceptsText?: boolean;
};

export type QueueItem = { readonly id: string; readonly text: string; readonly delivery: string };
export type TaskView = { readonly id: string; readonly label: string; readonly status: string; readonly detail?: string };

export type TuiState = {
  readonly sessionId: string;
  readonly status: string;
  readonly model: string;
  readonly messages: readonly Message[];
  /** Draft identity must include model step, so separate responses cannot merge. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly reasoning: Readonly<Record<string, string>>;
  readonly tools: readonly ToolView[];
  readonly interactions: readonly InteractionView[];
  readonly queue: readonly QueueItem[];
  readonly queueState: string;
  readonly tasks: readonly TaskView[];
  readonly notices: readonly string[];
  readonly usage?: string;
  readonly cost?: string;
  readonly goal?: string;
  readonly verification?: string;
  readonly lastError?: string;
  readonly canRetry: boolean;
};

/** Projection operations are local rendering updates produced by the C4 adapter. */
export type ViewUpdate =
  | { readonly type: 'message'; readonly message: Message; readonly replacesDraft?: string }
  | { readonly type: 'draft'; readonly id: string; readonly delta: string; readonly reasoning?: boolean }
  | { readonly type: 'clear_draft'; readonly id: string }
  | { readonly type: 'tool'; readonly tool: ToolView }
  | { readonly type: 'interaction'; readonly interaction: InteractionView }
  | { readonly type: 'interaction_resolved'; readonly id: string }
  | { readonly type: 'queue'; readonly queue: readonly QueueItem[] }
  | { readonly type: 'tasks'; readonly tasks: readonly TaskView[] }
  | { readonly type: 'status'; readonly status: string }
  | { readonly type: 'model'; readonly model: string }
  | { readonly type: 'usage'; readonly usage: string }
  | { readonly type: 'retry'; readonly canRetry: boolean }
  | { readonly type: 'notice'; readonly notice: string };

function upsert<T extends { readonly id: string }>(items: readonly T[], item: T): readonly T[] {
  const index = items.findIndex((current) => current.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((current, position) => position === index ? item : current);
}

function without(record: Readonly<Record<string, string>>, id: string): Readonly<Record<string, string>> {
  const next = { ...record };
  delete next[id];
  return next;
}

/** Fold ordered, accepted projection updates into an immutable display state. */
export function updateView(state: TuiState, update: ViewUpdate): TuiState {
  switch (update.type) {
    case 'message':
      return {
        ...state,
        messages: upsert(state.messages, update.message),
        drafts: update.replacesDraft ? without(state.drafts, update.replacesDraft) : state.drafts,
        reasoning: update.replacesDraft ? without(state.reasoning, update.replacesDraft) : state.reasoning,
      };
    case 'draft': {
      const field = update.reasoning ? 'reasoning' : 'drafts';
      return { ...state, [field]: { ...state[field], [update.id]: (state[field][update.id] ?? '') + update.delta } };
    }
    case 'clear_draft':
      return { ...state, drafts: without(state.drafts, update.id), reasoning: without(state.reasoning, update.id) };
    case 'tool': return { ...state, tools: upsert(state.tools, update.tool) };
    case 'interaction': return { ...state, interactions: upsert(state.interactions, update.interaction) };
    case 'interaction_resolved': return { ...state, interactions: state.interactions.filter(item => item.id !== update.id) };
    case 'queue': return { ...state, queue: update.queue };
    case 'tasks': return { ...state, tasks: update.tasks };
    case 'status': return { ...state, status: update.status };
    case 'model': return { ...state, model: update.model };
    case 'usage': return { ...state, usage: update.usage };
    case 'retry': return { ...state, canRetry: update.canRetry };
    case 'notice': return { ...state, notices: [...state.notices, update.notice] };
  }
}
