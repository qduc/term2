import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Item, ModelRef, ToolCallId } from '../model/index.js';
import type { ToolRegistry, Workspace } from '../tools/index.js';
import type { SettingsReader } from '../config/index.js';
import type { ApprovalDecision, Engine, TurnBudget, TurnCheckpoint, TurnId, TurnRun } from '../engine/index.js';
import type {
  Admission,
  ClientRequestId,
  InteractionId,
  LogEntry,
  Session,
  SessionFact,
  SessionId,
  SessionLog,
  SessionState,
  SessionStore,
  SessionSummary,
  SessionUpdate,
} from './index.js';
import { JsonlSessionLog } from './jsonl-log.js';
import { initialState, project } from './reducer.js';

export type LocalStoreOptions = {
  readonly root: string;
  readonly engine: Engine;
  readonly tools: ToolRegistry;
  readonly settings: SettingsReader;
  readonly instructions: string;
  readonly budget: TurnBudget;
};

const newId = <T extends string>(prefix: string): T => `${prefix}_${crypto.randomUUID()}` as T;

/** Sessions as JSONL files under one directory. */
export class LocalSessionStore implements SessionStore {
  readonly #options: LocalStoreOptions;

  constructor(options: LocalStoreOptions) {
    this.#options = options;
    fs.mkdirSync(options.root, { recursive: true });
  }

  async create(workspace: Workspace, model: ModelRef): Promise<Session> {
    const id = newId<SessionId>('ses');
    const session = new LocalSession(id, new JsonlSessionLog(this.#file(id)), [], this.#options);
    await session.commit([{ type: 'session_created', workspace, model }]);
    return session;
  }

  async open(id: SessionId): Promise<Session> {
    const file = this.#file(id);
    if (!fs.existsSync(file)) throw new Error(`no session ${id}`);
    const log = new JsonlSessionLog(file);
    const entries: LogEntry[] = [];
    for await (const entry of log.read()) entries.push(entry);
    const session = new LocalSession(id, log, entries, this.#options);
    await session.reconcile();
    return session;
  }

  async list(): Promise<{ readonly sessions: readonly SessionSummary[]; readonly nextCursor: string | null }> {
    const sessions: SessionSummary[] = [];
    for (const name of fs.readdirSync(this.#options.root)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length) as SessionId;
      const log = new JsonlSessionLog(this.#file(id));
      let state = initialState(id);
      let updatedAt = '';
      for await (const entry of log.read()) {
        state = project(state, entry);
        updatedAt = entry.at;
      }
      sessions.push({
        id,
        status: state.status,
        workspace: state.workspace,
        lastSeq: state.lastSeq,
        title: null,
        updatedAt,
      });
    }
    return { sessions, nextCursor: null };
  }

  #file(id: SessionId): string {
    if (!/^ses_[0-9a-f-]{36}$/.test(id)) throw new Error('invalid session id');
    return path.join(this.#options.root, `${id}.jsonl`);
  }
}

class LocalSession implements Session {
  readonly id: SessionId;
  readonly #log: SessionLog;
  readonly #options: LocalStoreOptions;
  readonly #entries: LogEntry[];
  readonly #listeners = new Set<(update: SessionUpdate) => void>();
  readonly #seenRequests = new Map<ClientRequestId, TurnId>();
  #state: SessionState;
  #run: TurnRun | null = null;

  constructor(id: SessionId, log: SessionLog, entries: LogEntry[], options: LocalStoreOptions) {
    this.id = id;
    this.#log = log;
    this.#options = options;
    this.#entries = [...entries];
    this.#state = entries.reduce(project, initialState(id));
    for (const entry of entries) {
      if (entry.fact.type === 'turn_started' && entry.fact.requestId) {
        this.#seenRequests.set(entry.fact.requestId, entry.fact.turnId);
      }
    }
  }

  state(): SessionState {
    return this.#state;
  }

  async submit(requestId: ClientRequestId, items: readonly Item[]): Promise<Admission> {
    const seen = this.#seenRequests.get(requestId);
    if (seen) return { kind: 'duplicate', turnId: seen };
    if (this.#state.status === 'closed') return { kind: 'rejected', reason: 'closed' };
    // The tracer has no queue: a busy session refuses instead of queueing.
    if (this.#state.status === 'running' || this.#state.status === 'awaiting_interaction') {
      return { kind: 'rejected', reason: 'queue_full' };
    }
    const turnId = newId<TurnId>('turn');
    this.#seenRequests.set(requestId, turnId);
    await this.commit([
      { type: 'turn_started', turnId, requestId },
      ...items.map((item): SessionFact => ({ type: 'item_committed', turnId, item })),
    ]);
    this.#startTurn(turnId);
    return { kind: 'started', turnId };
  }

  async decide(
    interactionId: InteractionId,
    decisions: readonly { readonly callId: ToolCallId; readonly decision: ApprovalDecision }[],
  ): Promise<void> {
    const pending = this.#state.pendingInteraction;
    const checkpoint = this.#state.lastCheckpoint;
    if (!pending || pending.interactionId !== interactionId || !checkpoint) throw new Error('stale interaction');
    await this.commit([{ type: 'interaction_resolved', interactionId, decisions }]);
    this.#drive(this.#options.engine.resume(checkpoint, new Map(decisions.map((d) => [d.callId, d.decision]))));
  }

  async cancel(): Promise<void> {
    this.#run?.cancel();
  }

  async retry(): Promise<Admission> {
    if (!this.#state.canRetry) return { kind: 'rejected', reason: 'closed' };
    const turnId = newId<TurnId>('turn');
    await this.commit([{ type: 'turn_started', turnId, requestId: null }]);
    this.#startTurn(turnId);
    return { kind: 'started', turnId };
  }

  async compact(): Promise<void> {
    throw new Error('compaction is not part of the tracer');
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.commit([{ type: 'model_changed', model }]);
  }

  subscribe(fromSeq: number, listener: (update: SessionUpdate) => void): () => void {
    for (const entry of this.#entries) if (entry.seq > fromSeq) listener({ kind: 'fact', entry });
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.#run?.cancel();
    this.#listeners.clear();
  }

  /** Called once on open: resume a crashed turn when that is safe, otherwise mark it interrupted. */
  async reconcile(): Promise<void> {
    const { status, activeTurnId, lastCheckpoint } = this.#state;
    if (status !== 'running' || !activeTurnId) return;
    if (lastCheckpoint && this.#safeToResume(lastCheckpoint)) {
      this.#drive(this.#options.engine.resume(lastCheckpoint, new Map()));
      return;
    }
    await this.commit([
      { type: 'turn_interrupted', turnId: activeTurnId, reason: 'process stopped during a step that cannot be re-run' },
    ]);
  }

  async commit(facts: readonly SessionFact[]): Promise<void> {
    const seqs = await this.#log.append(facts);
    const at = new Date().toISOString();
    facts.forEach((fact, index) => {
      const entry: LogEntry = { seq: seqs[index]!, at, fact };
      this.#entries.push(entry);
      this.#state = project(this.#state, entry);
      this.#emit({ kind: 'fact', entry });
    });
  }

  #safeToResume(checkpoint: TurnCheckpoint): boolean {
    return checkpoint.pendingCalls.every((call) => this.#options.tools.get(call.toolName)?.idempotent === true);
  }

  #startTurn(turnId: TurnId): void {
    this.#drive(
      this.#options.engine.start({
        turnId,
        history: this.#state.history,
        newItems: [],
        instructions: this.#options.instructions,
        model: this.#state.model,
        toolNames: this.#options.tools
          .available({ workspace: this.#state.workspace, settings: this.#options.settings })
          .map((tool) => tool.spec.name),
        workspace: this.#state.workspace,
        budget: this.#options.budget,
      }),
    );
  }

  /** Runs a turn to its end, turning each step boundary into one atomic append. */
  #drive(run: TurnRun): void {
    this.#run = run;
    void (async () => {
      let items: SessionFact[] = [];
      for await (const event of run.events) {
        switch (event.type) {
          case 'item':
            items.push({ type: 'item_committed', turnId: run.turnId, item: event.item });
            break;
          case 'checkpoint':
            await this.commit([...items, { type: 'checkpoint_saved', checkpoint: event.checkpoint }]);
            items = [];
            break;
          case 'turn_ended': {
            const outcome = event.outcome;
            if (outcome.kind === 'suspended') {
              await this.commit([
                ...items,
                { type: 'checkpoint_saved', checkpoint: outcome.checkpoint },
                {
                  type: 'interaction_opened',
                  turnId: run.turnId,
                  interactionId: newId<InteractionId>('int'),
                  approvals: outcome.approvals,
                },
              ]);
            } else {
              const ended = outcome.kind === 'completed' ? 'completed' : outcome.kind;
              await this.commit([...items, { type: 'turn_ended', turnId: run.turnId, outcome: ended }]);
            }
            items = [];
            break;
          }
          default:
            this.#emit({ kind: 'live', turnId: run.turnId, event });
        }
      }
      if (this.#run === run) this.#run = null;
    })();
  }

  #emit(update: SessionUpdate): void {
    for (const listener of this.#listeners) listener(update);
  }
}
