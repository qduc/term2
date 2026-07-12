export type ItemId = string & { readonly __itemId: unique symbol };
export type ExecutionId = string & { readonly __executionId: unique symbol };
export type ActionId = string & { readonly __actionId: unique symbol };

export type QueuePauseReason = 'failure' | 'manual' | 'recovered_interrupted';

export type PreflightKind = 'input_surge' | 'large_uncached_input';
export type ActiveActionKind = 'tool_approval' | 'ask_user';

export type PersistedQueueV1<Snapshot = unknown> = {
  readonly version: 1;
  readonly nextSequence: number;
  readonly queue: readonly PersistedQueueItem[];
  readonly pause?: { readonly reason: QueuePauseReason; readonly detail?: unknown };
  readonly active?: {
    readonly executionId: ExecutionId;
    readonly item: PersistedQueueItem;
    readonly snapshot: Readonly<Snapshot>;
    readonly phase: 'running' | 'awaiting_active_action' | 'cancelling' | 'completing';
    readonly pendingAction?: { readonly actionId: string; readonly kind: ActiveActionKind };
  };
};

/** The backing store must replace a complete record atomically. */
export interface QueuePersistence<Snapshot = unknown> {
  load(): unknown;
  replace(record: PersistedQueueV1<Snapshot>): void | Promise<void>;
  quarantine?(): void | Promise<void>;
}

export type QueueRecovery =
  | { readonly kind: 'recovered_interrupted'; readonly interruptedExecutionId: ExecutionId }
  | { readonly kind: 'invalid_persisted_queue'; readonly detail: string }
  | { readonly kind: 'persistence_failed'; readonly detail: string };

export interface PersistedQueueItem {
  readonly id: string;
  readonly text: string;
  readonly sequence: number;
  readonly submittedAt: string;
  readonly preflight?: { readonly actionId: string; readonly kind: PreflightKind };
}

export interface QueueItem {
  readonly id: ItemId;
  readonly text: string;
  readonly sequence: number;
  readonly submittedAt: string;
  readonly preflight?: { readonly actionId: ActionId; readonly kind: PreflightKind };
}

export interface ActiveExecution<Snapshot> {
  readonly executionId: ExecutionId;
  readonly item: QueueItem;
  readonly snapshot: Readonly<Snapshot>;
}

export type QueueState<Snapshot> =
  | { readonly kind: 'idle'; readonly queue: readonly QueueItem[]; readonly recovery?: QueueRecovery }
  | {
      readonly kind: 'awaiting_preflight';
      readonly queue: readonly QueueItem[];
      readonly head: QueueItem;
      readonly recovery?: QueueRecovery;
    }
  | {
      readonly kind: 'running';
      readonly queue: readonly QueueItem[];
      readonly active: ActiveExecution<Snapshot>;
      readonly recovery?: QueueRecovery;
    }
  | {
      readonly kind: 'awaiting_active_action';
      readonly queue: readonly QueueItem[];
      readonly active: ActiveExecution<Snapshot>;
      readonly pendingAction: { readonly actionId: ActionId; readonly kind: ActiveActionKind };
      readonly recovery?: QueueRecovery;
    }
  | {
      readonly kind: 'cancelling';
      readonly queue: readonly QueueItem[];
      readonly active: ActiveExecution<Snapshot>;
      readonly recovery?: QueueRecovery;
    }
  | {
      readonly kind: 'completing';
      readonly queue: readonly QueueItem[];
      readonly active: ActiveExecution<Snapshot>;
      readonly recovery?: QueueRecovery;
    }
  | {
      readonly kind: 'paused';
      readonly queue: readonly QueueItem[];
      readonly reason: QueuePauseReason;
      readonly recovery?: QueueRecovery;
    };

export type QueueCommand =
  | { readonly kind: 'submit'; readonly text: string }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'answer_preflight';
      readonly itemId: ItemId;
      readonly actionId: ActionId;
      readonly accepted: boolean;
    }
  | {
      readonly kind: 'resolve_tool_approval';
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly approved: boolean;
    }
  | {
      readonly kind: 'answer_ask_user';
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly value: string;
    }
  | { readonly kind: 'resume_queue' }
  | { readonly kind: 'discard_queue' }
  | { readonly kind: 'edit_queued'; readonly itemId: ItemId; readonly text: string }
  | { readonly kind: 'remove_queued'; readonly itemId: ItemId }
  | { readonly kind: 'change_execution_settings'; readonly settings: unknown }
  | { readonly kind: 'change_cosmetic_settings'; readonly settings: unknown };

export type TurnEvent<Terminal = unknown> =
  | { readonly kind: 'completed'; readonly executionId: ExecutionId; readonly terminal: Terminal }
  | { readonly kind: 'failed'; readonly executionId: ExecutionId; readonly failure: unknown }
  | { readonly kind: 'cancelled'; readonly executionId: ExecutionId }
  | {
      readonly kind: 'tool_approval_requested';
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly request: unknown;
    }
  | {
      readonly kind: 'ask_user_requested';
      readonly executionId: ExecutionId;
      readonly actionId: ActionId;
      readonly question: unknown;
    };

export type QueueCommandResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: 'capacity' | 'invalid' | 'not_queued' | 'stale' | 'inapplicable' }
  | { readonly kind: 'no_op' };

export interface ToolApprovalResolution {
  readonly approved: boolean;
}

export interface AskUserResolution {
  readonly value: string;
}

export interface QueueTurnDriver<Snapshot> {
  start(execution: ActiveExecution<Snapshot>): void | Promise<void>;
  cancel(execution: ActiveExecution<Snapshot>): void | Promise<void>;
  continueAfterAction?(
    execution: ActiveExecution<Snapshot>,
    pendingAction: { actionId: string; kind: ActiveActionKind },
    resolution: ToolApprovalResolution | AskUserResolution,
  ): void | Promise<void>;
}

export interface QueueControllerOptions<Snapshot, Terminal = unknown> {
  readonly driver: QueueTurnDriver<Snapshot>;
  readonly snapshotFactory: (item: QueueItem) => Snapshot;
  readonly capacity?: number;
  readonly ids?: { readonly item: () => string; readonly execution: () => string; readonly action?: () => string };
  readonly now?: () => string;
  readonly completionBarrier?: (event: Extract<TurnEvent<Terminal>, { kind: 'completed' }>) => void | Promise<void>;
  readonly persistence?: QueuePersistence<Snapshot>;
  readonly preflightEvaluator?: (item: QueueItem) => { preflight: { actionId: ActionId; kind: PreflightKind } } | null;
}

const freeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
  return value;
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isPauseReason = (value: unknown): value is QueuePauseReason =>
  value === 'failure' || value === 'manual' || value === 'recovered_interrupted';

const isValidPreflightKind = (value: unknown): value is PreflightKind =>
  value === 'input_surge' || value === 'large_uncached_input';

const isValidActiveActionKind = (value: unknown): value is ActiveActionKind =>
  value === 'tool_approval' || value === 'ask_user';

const isPersistedQueueItem = (value: unknown): value is PersistedQueueItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (
    !isNonEmptyString(item.id) ||
    typeof item.text !== 'string' ||
    !Number.isSafeInteger(item.sequence) ||
    (item.sequence as number) <= 0 ||
    !isNonEmptyString(item.submittedAt) ||
    Number.isNaN(Date.parse(item.submittedAt as string))
  ) {
    return false;
  }
  if (item.preflight !== undefined) {
    if (
      !item.preflight ||
      typeof item.preflight !== 'object' ||
      !isNonEmptyString((item.preflight as Record<string, unknown>).actionId) ||
      !isValidPreflightKind((item.preflight as Record<string, unknown>).kind)
    ) {
      return false;
    }
  }
  return true;
};

const validatePersistedQueue = <Snapshot>(value: unknown): PersistedQueueV1<Snapshot> | string => {
  if (!value || typeof value !== 'object') return 'record must be an object';
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return 'unsupported queue record version';
  if (!Number.isSafeInteger(record.nextSequence) || (record.nextSequence as number) < 1) return 'invalid next sequence';
  if (!Array.isArray(record.queue) || !(record.queue as unknown[]).every(isPersistedQueueItem))
    return 'invalid queued item';
  const queue = record.queue as PersistedQueueItem[];
  if (queue.some((item, index) => index > 0 && item.sequence <= queue[index - 1]!.sequence)) {
    return 'queue sequences must be strictly increasing';
  }
  if (queue.some((item) => item.sequence >= (record.nextSequence as number)))
    return 'next sequence must exceed queue sequences';
  if (new Set(queue.map((item) => item.id)).size !== queue.length) return 'queue item IDs must be unique';
  if (record.pause !== undefined) {
    if (
      !record.pause ||
      typeof record.pause !== 'object' ||
      !isPauseReason((record.pause as Record<string, unknown>).reason)
    ) {
      return 'invalid pause record';
    }
  }
  if (record.active !== undefined) {
    if (!record.active || typeof record.active !== 'object') return 'invalid active record';
    const active = record.active as Record<string, unknown>;
    if (!isNonEmptyString(active.executionId) || !isPersistedQueueItem(active.item) || !('snapshot' in active))
      return 'invalid active ownership';
    if (!['running', 'awaiting_active_action', 'cancelling', 'completing'].includes(active.phase as string))
      return 'invalid active phase';
    if (active.pendingAction !== undefined) {
      if (
        !active.pendingAction ||
        typeof active.pendingAction !== 'object' ||
        !isNonEmptyString((active.pendingAction as Record<string, unknown>).actionId) ||
        !isValidActiveActionKind((active.pendingAction as Record<string, unknown>).kind)
      ) {
        return 'invalid active action';
      }
    }
    if (queue.some((item) => item.id === (active.item as PersistedQueueItem).id)) return 'active item is also queued';
  }
  return value as PersistedQueueV1<Snapshot>;
};

const persistedItemToQueueItem = (item: PersistedQueueItem): QueueItem =>
  freeze({
    ...item,
    id: item.id as ItemId,
    preflight: item.preflight
      ? { actionId: item.preflight.actionId as ActionId, kind: item.preflight.kind }
      : undefined,
  });

const queueItemToPersisted = (item: QueueItem): PersistedQueueItem => ({
  id: item.id,
  text: item.text,
  sequence: item.sequence,
  submittedAt: item.submittedAt,
  preflight: item.preflight ? { actionId: item.preflight.actionId, kind: item.preflight.kind } : undefined,
});

type InternalPhase =
  | 'idle'
  | 'awaiting_preflight'
  | 'running'
  | 'awaiting_active_action'
  | 'cancelling'
  | 'completing'
  | 'paused';

export class QueueController<Snapshot, Terminal = unknown> {
  readonly #driver: QueueTurnDriver<Snapshot>;
  readonly #snapshotFactory: (item: QueueItem) => Snapshot;
  readonly #capacity: number;
  readonly #itemId: () => string;
  readonly #executionId: () => string;
  readonly #actionId: () => string;
  readonly #now: () => string;
  readonly #completionBarrier?: (event: Extract<TurnEvent<Terminal>, { kind: 'completed' }>) => void | Promise<void>;
  readonly #persistence?: QueuePersistence<Snapshot>;
  readonly #preflightEvaluator?: (item: QueueItem) => { preflight: { actionId: ActionId; kind: PreflightKind } } | null;
  #nextSequence = 1;
  #queue: QueueItem[] = [];
  #phase: InternalPhase = 'idle';
  #active: ActiveExecution<Snapshot> | undefined;
  #pendingAction: { actionId: ActionId; kind: ActiveActionKind } | undefined;
  #pauseReason: QueuePauseReason | undefined;
  #recovery: QueueRecovery | undefined;

  constructor(options: QueueControllerOptions<Snapshot, Terminal>) {
    this.#driver = options.driver;
    this.#snapshotFactory = options.snapshotFactory;
    this.#capacity = options.capacity ?? Infinity;
    this.#itemId = options.ids?.item ?? (() => crypto.randomUUID());
    this.#executionId = options.ids?.execution ?? (() => crypto.randomUUID());
    this.#actionId = options.ids?.action ?? (() => crypto.randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#completionBarrier = options.completionBarrier;
    this.#persistence = options.persistence;
    this.#preflightEvaluator = options.preflightEvaluator;
    this.#restore();
  }

  state(): QueueState<Snapshot> {
    const queue = this.#queue.map((item) => ({ ...item }));
    const recovery = this.#recovery ? { recovery: this.#recovery } : {};

    if (this.#phase === 'awaiting_preflight') {
      return freeze({
        kind: 'awaiting_preflight',
        queue,
        head: { ...queue[0]! },
        ...recovery,
      });
    }
    if (this.#phase === 'awaiting_active_action') {
      return freeze({
        kind: 'awaiting_active_action',
        queue,
        active: this.#active!,
        pendingAction: this.#pendingAction!,
        ...recovery,
      });
    }
    if (this.#phase === 'paused') return freeze({ kind: 'paused', queue, reason: this.#pauseReason!, ...recovery });
    if (this.#phase === 'cancelling') return freeze({ kind: 'cancelling', queue, active: this.#active!, ...recovery });
    if (this.#phase === 'completing') return freeze({ kind: 'completing', queue, active: this.#active!, ...recovery });
    if (this.#active) return freeze({ kind: 'running', queue, active: this.#active, ...recovery });
    return freeze({ kind: 'idle', queue, ...recovery });
  }

  async command(cmd: QueueCommand): Promise<QueueCommandResult> {
    switch (cmd.kind) {
      case 'submit': {
        if (!cmd.text.trim()) return { kind: 'rejected', reason: 'invalid' };
        if (this.#queue.length >= this.#capacity) return { kind: 'rejected', reason: 'capacity' };
        this.#queue.push(
          freeze({
            id: this.#itemId() as ItemId,
            text: cmd.text,
            sequence: this.#nextSequence++,
            submittedAt: this.#now(),
          }),
        );
        await this.#persist();
        await this.#dispatch();
        return { kind: 'accepted' };
      }
      case 'cancel':
        return this.#cancel();
      case 'answer_preflight': {
        if (this.#phase !== 'awaiting_preflight') return { kind: 'rejected', reason: 'stale' };
        const head = this.#queue[0]!;
        if (head.id !== cmd.itemId || head.preflight?.actionId !== cmd.actionId) {
          return { kind: 'rejected', reason: 'stale' };
        }
        if (!cmd.accepted) {
          this.#queue.shift();
          this.#phase = 'idle';
          await this.#persist();
          await this.#dispatch();
          return { kind: 'accepted' };
        }
        return this.#acceptPreflight();
      }
      case 'resolve_tool_approval': {
        if (this.#phase !== 'awaiting_active_action') return { kind: 'rejected', reason: 'stale' };
        if (
          this.#active!.executionId !== cmd.executionId ||
          this.#pendingAction!.actionId !== cmd.actionId ||
          this.#pendingAction!.kind !== 'tool_approval'
        ) {
          return { kind: 'rejected', reason: 'stale' };
        }
        return this.#resolveAction(cmd);
      }
      case 'answer_ask_user': {
        if (this.#phase !== 'awaiting_active_action') return { kind: 'rejected', reason: 'stale' };
        if (
          this.#active!.executionId !== cmd.executionId ||
          this.#pendingAction!.actionId !== cmd.actionId ||
          this.#pendingAction!.kind !== 'ask_user'
        ) {
          return { kind: 'rejected', reason: 'stale' };
        }
        return this.#resolveAction(cmd);
      }
      case 'resume_queue':
        if (this.#phase !== 'paused') return { kind: 'no_op' };
        this.#phase = 'idle';
        this.#pauseReason = undefined;
        await this.#persist();
        await this.#dispatch();
        return { kind: 'accepted' };
      case 'discard_queue':
        this.#queue = [];
        await this.#persist();
        return { kind: 'accepted' };
      case 'edit_queued': {
        const index = this.#queue.findIndex((item) => item.id === cmd.itemId);
        if (index < 0 || !cmd.text.trim()) return { kind: 'rejected', reason: index < 0 ? 'not_queued' : 'invalid' };
        this.#queue[index] = freeze({ ...this.#queue[index], text: cmd.text });
        await this.#persist();
        return { kind: 'accepted' };
      }
      case 'remove_queued': {
        const index = this.#queue.findIndex((item) => item.id === cmd.itemId);
        if (index < 0) return { kind: 'rejected', reason: 'not_queued' };
        this.#queue.splice(index, 1);
        if (this.#phase === 'awaiting_preflight' && index === 0) {
          this.#phase = 'idle';
        }
        await this.#persist();
        if (this.#phase === 'idle') {
          await this.#dispatch();
        }
        return { kind: 'accepted' };
      }
      case 'change_execution_settings':
      case 'change_cosmetic_settings':
        await this.#persist();
        return { kind: 'accepted' };
    }
  }

  async event(event: TurnEvent<Terminal>): Promise<void> {
    if (event.kind === 'tool_approval_requested' || event.kind === 'ask_user_requested') {
      if (!this.#active || this.#active.executionId !== event.executionId || this.#phase !== 'running') return;
      this.#pendingAction = {
        actionId: event.actionId,
        kind: event.kind === 'tool_approval_requested' ? 'tool_approval' : 'ask_user',
      };
      this.#phase = 'awaiting_active_action';
      await this.#persist();
      return;
    }

    if (!this.#active || this.#active.executionId !== event.executionId) return;

    const activeFromPhase = this.#phase === 'running' || this.#phase === 'awaiting_active_action';
    if (!activeFromPhase) return;

    if (event.kind === 'failed') {
      this.#active = undefined;
      this.#pendingAction = undefined;
      this.#phase = 'paused';
      this.#pauseReason = 'failure';
      await this.#persist();
      return;
    }
    if (event.kind !== 'completed') return;

    this.#pendingAction = undefined;
    this.#phase = 'completing';
    await this.#persist();
    await this.#completionBarrier?.(event);
    if (this.#phase !== 'completing' || this.#active?.executionId !== event.executionId) return;
    this.#active = undefined;
    this.#phase = 'idle';
    await this.#persist();
    await this.#dispatch();
  }

  async #resolveAction(cmd: { approved: boolean } | { value: string }): Promise<QueueCommandResult> {
    const execution = this.#active!;
    const pendingAction = this.#pendingAction!;
    this.#phase = 'running';
    this.#pendingAction = undefined;
    await this.#persist();
    if (this.#driver.continueAfterAction) {
      const resolution = 'approved' in cmd ? { approved: cmd.approved } : { value: cmd.value };
      try {
        await this.#driver.continueAfterAction(execution, pendingAction, resolution);
      } catch {
        this.#active = undefined;
        this.#phase = 'paused';
        this.#pauseReason = 'failure';
        await this.#persist();
      }
    }
    return { kind: 'accepted' };
  }

  async #acceptPreflight(): Promise<QueueCommandResult> {
    const item = this.#queue.shift()!;
    const active = freeze({
      executionId: this.#executionId() as ExecutionId,
      item,
      snapshot: freeze(structuredClone(this.#snapshotFactory(item))),
    });
    this.#active = active;
    this.#phase = 'running';
    await this.#persist();
    try {
      await this.#driver.start(active);
    } catch {
      this.#queue.unshift(item);
      this.#active = undefined;
      this.#phase = 'paused';
      this.#pauseReason = 'failure';
      await this.#persist();
    }
    return { kind: 'accepted' };
  }

  async #cancel(): Promise<QueueCommandResult> {
    if (this.#phase === 'awaiting_preflight') {
      this.#phase = 'paused';
      this.#pauseReason = 'manual';
      await this.#persist();
      return { kind: 'accepted' };
    }
    if (!this.#active || (this.#phase !== 'running' && this.#phase !== 'awaiting_active_action')) {
      if (this.#phase !== 'cancelling') return { kind: 'no_op' };
      return { kind: 'no_op' };
    }
    const active = this.#active;
    this.#phase = 'cancelling';
    this.#pendingAction = undefined;
    await this.#persist();
    try {
      await this.#driver.cancel(active);
    } finally {
      if (this.#active?.executionId === active.executionId) {
        this.#active = undefined;
        this.#phase = 'paused';
        this.#pauseReason = 'manual';
        await this.#persist();
      }
    }
    return { kind: 'accepted' };
  }

  async #dispatch(): Promise<void> {
    if (this.#phase !== 'idle' || this.#active || this.#queue.length === 0) return;

    const head = this.#queue[0]!;

    // If the head already has a preflight (e.g. recovered), respect it.
    if (head.preflight) {
      this.#phase = 'awaiting_preflight';
      await this.#persist();
      return;
    }

    const preflight = this.#preflightEvaluator?.(head)?.preflight;
    if (preflight) {
      this.#queue[0] = freeze({ ...head, preflight: { actionId: preflight.actionId, kind: preflight.kind } });
      this.#phase = 'awaiting_preflight';
      await this.#persist();
      return;
    }

    const item = this.#queue.shift()!;
    const active = freeze({
      executionId: this.#executionId() as ExecutionId,
      item,
      snapshot: freeze(structuredClone(this.#snapshotFactory(item))),
    });
    this.#active = active;
    this.#phase = 'running';
    await this.#persist();
    try {
      await this.#driver.start(active);
    } catch {
      this.#queue.unshift(item);
      this.#active = undefined;
      this.#phase = 'paused';
      this.#pauseReason = 'failure';
      await this.#persist();
    }
  }

  #restore(): void {
    if (!this.#persistence) return;
    let raw: unknown;
    try {
      raw = this.#persistence.load();
    } catch (error) {
      this.#recovery = {
        kind: 'invalid_persisted_queue',
        detail: error instanceof Error ? error.message : String(error),
      };
      void this.#quarantine();
      return;
    }
    if (raw === null || raw === undefined) return;
    const record = validatePersistedQueue<Snapshot>(raw);
    if (typeof record === 'string') {
      this.#recovery = { kind: 'invalid_persisted_queue', detail: record };
      void this.#quarantine();
      return;
    }
    this.#nextSequence = record.nextSequence;
    this.#queue = record.queue.map((item) => {
      const queueItem = persistedItemToQueueItem(item);
      if (queueItem.preflight && !this.#preflightEvaluator) {
        return freeze({
          ...queueItem,
          preflight: {
            actionId: this.#actionId() as ActionId,
            kind: queueItem.preflight.kind,
          },
        });
      }
      return queueItem;
    });
    if (record.active) {
      this.#phase = 'paused';
      this.#pauseReason = 'recovered_interrupted';
      this.#recovery = { kind: 'recovered_interrupted', interruptedExecutionId: record.active.executionId };
      return;
    }
    if (record.pause) {
      this.#phase = 'paused';
      this.#pauseReason = record.pause.reason;
      return;
    }
    if (this.#queue.length > 0) {
      this.#phase = 'paused';
      this.#pauseReason = 'recovered_interrupted';
    }
  }

  async #persist(): Promise<void> {
    if (!this.#persistence) return;
    const active = this.#active
      ? {
          executionId: this.#active.executionId,
          item: queueItemToPersisted(this.#active.item),
          snapshot: this.#active.snapshot,
          phase: this.#phase as 'running' | 'awaiting_active_action' | 'cancelling' | 'completing',
          ...(this.#pendingAction
            ? {
                pendingAction: {
                  actionId: this.#pendingAction.actionId,
                  kind: this.#pendingAction.kind,
                },
              }
            : {}),
        }
      : undefined;
    const record: PersistedQueueV1<Snapshot> = {
      version: 1,
      nextSequence: this.#nextSequence,
      queue: this.#queue.map((item) => queueItemToPersisted(item)),
      ...(this.#phase === 'paused' ? { pause: { reason: this.#pauseReason! } } : {}),
      ...(active ? { active } : {}),
    };
    try {
      await this.#persistence.replace(record);
    } catch (error) {
      this.#recovery = { kind: 'persistence_failed', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async #quarantine(): Promise<void> {
    try {
      await this.#persistence?.quarantine?.();
    } catch {
      // Recovery state already reports the rejected record. Quarantine is best effort.
    }
  }
}
