/** Canonical filesystem SessionStore. The source conversation log is its sole authority. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type {
  Session,
  SessionDecision,
  SessionFact,
  SessionId,
  SessionLog,
  SessionState,
  SessionStore,
  SessionSummary,
} from './index.js';
import {
  CanonicalSessionLog,
  auditCanonicalConversation,
  loadCanonicalConversation,
  type CanonicalSessionLog as CanonicalLog,
  type SessionBinding,
} from './adopted/conversation-log.js';
import { initialState, projectLifecycle, statusFromLegacyAudit, withTranscript } from './reducer.js';

export type SessionDriver = Pick<
  Session,
  'submit' | 'decide' | 'cancel' | 'retry' | 'compact' | 'setModel' | 'subscribe'
>;
export type SessionDriverContext = {
  readonly id: SessionId;
  readonly log: SessionLog;
  state(): SessionState;
  /** Replace state only after the caller has durably appended the supplied facts. */
  commit(facts: readonly SessionFact[]): Promise<void>;
};
export type SessionStoreOptions = {
  readonly root: string;
  readonly logger: Parameters<typeof CanonicalSessionLog.create>[0]['logger'];
  readonly defaultWorkspace: Workspace;
  readonly defaultModel: ModelRef;
  readonly admissionTtlMs?: number;
  /** Adopted source runtime driver; the store remains the only log writer. */
  readonly driverFactory: (context: SessionDriverContext) => SessionDriver;
};

export class LocalSessionStore implements SessionStore {
  readonly #options: SessionStoreOptions;
  constructor(options: SessionStoreOptions) {
    this.#options = options;
  }

  async create(workspace: Workspace, model: ModelRef, binding?: SessionBinding): Promise<Session> {
    fs.mkdirSync(this.#options.root, { recursive: true });
    const id = `ses_${crypto.randomUUID()}` as SessionId;
    const log = CanonicalSessionLog.create({
      root: this.#options.root,
      id,
      metadata: { projectPath: workspace.root, model: model.model, provider: model.provider },
      workspace,
      model,
      ...(binding ? { binding } : {}),
      logger: this.#options.logger,
    });
    return this.#makeSession(id, log, replayState(id, log, this.#options));
  }

  async open(id: SessionId): Promise<Session> {
    // Acquire the existing source writer lock before replay and reconciliation.
    const log = CanonicalSessionLog.open({ root: this.#options.root, id, logger: this.#options.logger });
    try {
      let state = replayState(id, log, this.#options);
      if (state.status === 'closed') throw new Error(`session ${id} is closed`);
      const facts: SessionFact[] = [];
      const pending = state.pendingInteraction;
      if (pending) {
        const identity = {
          turnId: pending.turnId,
          interactionId: pending.interaction.interactionId,
          revision: pending.interaction.revision,
          generation: pending.generation,
        };
        facts.push({ type: 'session_interaction_recovered', version: 1, ...identity, reason: 'daemon_restart' });
        const pendingFact = [...log.entries()]
          .reverse()
          .find(
            (entry) => entry.fact.type === 'session_interaction_pending' && entry.fact.turnId === pending.turnId,
          )?.fact;
        if (
          pendingFact?.type === 'session_interaction_pending' &&
          pendingFact.settleOnRecovery === 'child_interrupted' &&
          pendingFact.child
        ) {
          facts.push({
            type: 'subagent_interrupted',
            agentId: pendingFact.child.agentId,
            role: pendingFact.child.role,
            finalText: 'Child interaction interrupted by daemon restart.',
          });
        }
        facts.push({ type: 'session_interaction_resolved', version: 1, ...identity, outcome: 'cancelled' });
      }
      for (const admission of Object.values(state.admissions)) {
        if (admission.result) continue;
        const started = log
          .entries()
          .some((entry) => entry.fact.type === 'session_turn_started' && entry.fact.turnId === admission.turnId);
        const terminal = [...log.entries()]
          .reverse()
          .find((entry) => entry.fact.type === 'session_turn_ended' && entry.fact.turnId === admission.turnId)?.fact;
        if (admission.disposition === 'queued' && !started && !terminal) {
          facts.push({
            type: 'session_admission_settled',
            version: 1,
            clientRequestId: admission.clientRequestId,
            turnId: admission.turnId,
            result: 'queue_discarded',
          });
        } else if (terminal?.type === 'session_turn_ended') {
          const result =
            terminal.outcome === 'completed' ? 'accepted' : terminal.outcome === 'cancelled' ? 'aborted' : 'failed';
          facts.push({
            type: 'session_admission_settled',
            version: 1,
            clientRequestId: admission.clientRequestId,
            turnId: admission.turnId,
            result,
          });
        } else if (admission.disposition === 'started' && !terminal) {
          facts.push({
            type: 'session_admission_settled',
            version: 1,
            clientRequestId: admission.clientRequestId,
            turnId: admission.turnId,
            result: 'aborted',
          });
        }
      }
      const priorInterrupt = log
        .entries()
        .some(
          (entry) =>
            entry.fact.type === 'session_interrupted' &&
            (state.activeTurnId === null || entry.fact.turnId === state.activeTurnId),
        );
      if (
        (state.status === 'running' || state.status === 'awaiting_interaction' || state.status === 'interrupted') &&
        !priorInterrupt
      ) {
        facts.push({
          type: 'session_interrupted',
          version: 1,
          turnId: state.activeTurnId,
          reason: 'daemon_restart',
          interruptedAt: new Date().toISOString(),
        });
      }
      if (facts.length) {
        await log.append(facts);
        state = replayState(id, log, this.#options);
      }
      return this.#makeSession(id, log, state);
    } catch (error) {
      await log.dispose();
      throw error;
    }
  }

  async list(cursor?: string): Promise<{ sessions: readonly SessionSummary[]; nextCursor: string | null }> {
    const names = fs.existsSync(this.#options.root)
      ? fs
          .readdirSync(this.#options.root)
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => name.slice(0, -6))
          .sort()
      : [];
    const start = cursor ? Math.max(0, names.findIndex((id) => id === cursor) + 1) : 0;
    const page = names.slice(start, start + 100);
    const sessions: SessionSummary[] = [];
    for (const id of page) {
      const entries = CanonicalSessionLog.readOnly(this.#options.root, id);
      const state = replayState(
        id as SessionId,
        { entries: () => entries } as unknown as CanonicalLog,
        this.#options,
        this.#options.root,
      );
      sessions.push({
        id: state.id,
        status: state.status,
        workspace: state.workspace,
        lastSeq: state.lastSeq,
        title: state.messages.length
          ? String((state.messages.at(-1) as { text?: unknown })?.text ?? '').slice(0, 80) || null
          : null,
        updatedAt: entries.at(-1)?.at ?? new Date(0).toISOString(),
      });
    }
    return { sessions, nextCursor: start + page.length < names.length && page.length ? page.at(-1)! : null };
  }

  #makeSession(id: SessionId, log: CanonicalLog, state: SessionState): Session {
    let current = state;
    const context: SessionDriverContext = {
      id,
      log,
      state: () => current,
      commit: async (facts) => {
        const entries = await log.append(facts);
        for (const entry of entries) current = projectLifecycle(current, entry);
      },
    };
    const driver = this.#options.driverFactory(context);
    return {
      id,
      state: () => current,
      submit: (...args) => driver.submit(...args),
      decide: (decision: SessionDecision) => driver.decide(decision),
      cancel: () => driver.cancel(),
      retry: () => driver.retry(),
      compact: () => driver.compact(),
      setModel: (model) => driver.setModel(model),
      subscribe: (...args) => driver.subscribe(...args),
      close: () => log.dispose(),
      closeLog: async (
        closedAt = new Date().toISOString(),
        retentionEligibleAt = new Date(Date.parse(closedAt) + 30 * 86400000).toISOString(),
      ) => {
        await context.commit([{ type: 'session_closed', version: 1, closedAt, retentionEligibleAt }]);
      },
    };
  }
}

function replayState(
  id: SessionId,
  log: Pick<CanonicalLog, 'entries'>,
  options: SessionStoreOptions,
  explicitRoot?: string,
): SessionState {
  const entries = log.entries();
  const binding = entries.find((entry) => entry.fact.type === 'session_bound')?.fact;
  const init = entries.find((entry) => entry.fact.type === 'session_init')?.fact;
  const workspace =
    binding?.type === 'session_bound'
      ? binding.workspace
      : {
          ...options.defaultWorkspace,
          ...(init?.type === 'session_init' && init.projectPath ? { root: init.projectPath } : {}),
        };
  const model =
    binding?.type === 'session_bound'
      ? binding.model
      : {
          ...options.defaultModel,
          ...(init?.type === 'session_init' && init.model ? { model: init.model } : {}),
          ...(init?.type === 'session_init' && init.provider ? { provider: init.provider } : {}),
        };
  let state = initialState(id, workspace, model);
  for (const entry of entries) state = projectLifecycle(state, entry);
  const root = explicitRoot ?? (log as CanonicalLog).root;
  const restored = loadCanonicalConversation(id, root);
  state = withTranscript(
    state,
    { history: restored.history, messages: restored.messages },
    restored.history as unknown as import('../model/index.js').Item[],
  );
  const audit = auditCanonicalConversation(id, explicitRoot ?? (log as CanonicalLog).root);
  const hasLifecycleTurn = entries.some(
    (entry) => entry.fact.type === 'session_turn_started' || entry.fact.type === 'session_interrupted',
  );
  if (!hasLifecycleTurn) state = statusFromLegacyAudit(state, audit.outcome);
  return { ...state, lastSeq: entries.at(-1)?.seq ?? 0 };
}
