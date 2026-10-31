/**
 * The direct application: one store, one in-process host and the runtime each
 * session needs. Every mode is a client of this host. Only `host.dispose()` ends
 * Sessions, so a client disconnecting never stops work another client can see.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getModelContextWindow } from '../../../source/providers/model-catalog/catalog.js';
import { createDirectInProcessHost } from '../host/in-process-direct.js';
import type { DirectHost, Principal } from '../host/in-process-direct-types.js';
import type { HeadlessApprovalDecider } from '../clients/headless/index.js';
import { decideHeadlessApproval } from '../clients/headless/index.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import type { DirectCommandCapabilities } from '../protocol/direct-capabilities.js';
import { forkDirectConversation } from '../session/direct-fork.js';
import { createDirectSessionStore, type DirectLocalStore } from '../session/direct-store.js';
import type { DurableGoal } from '../session/direct-goal.js';
import type { DirectSession, DirectSessionState } from '../session/facade-types.js';
import { readFacts } from '../session/log.js';
import { replay } from '../session/replay.js';
import type { InteractionDecision } from '../engine/index.js';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
import type { ProfileSelection } from './tool-contract.js';
import { startDirectHooks, type DirectHookOptions } from './direct-application-hooks.js';
import { createDirectRuntimes, type DirectRuntimeOptions, type DirectRuntimes } from './direct-application-runtime.js';
import { rollSessionOver } from './direct-application-rollover.js';
import { LOCAL_PRINCIPAL, type DirectAuthority, type DirectAuthorityFactory } from './direct-application-workspaces.js';
import { createDirectInputPreview } from './direct-input-preview.js';
import { sessionStart } from './direct-host-config-access.js';

export type DirectApplicationOptions = Omit<DirectRuntimeOptions, 'canRun' | 'rollover'> & {
  readonly conversationsDir: string;
  readonly authority: DirectAuthority | DirectAuthorityFactory;
  /** The modes with public hooks today: the terminal UI and headless. ACP and serve have none. */
  readonly hooks?: DirectHookOptions;
};

/** Read from the session's own log and runtime, for clients that report it. */
export type DirectSessionDetails = {
  readonly createdAt: string;
  /** When the last accepted fact at the requested cut was written. */
  readonly updatedAt: string;
  /** Logs are never truncated, so a cursor can reach back to the first line. */
  readonly earliestSeq: number;
  readonly logPath: string;
  readonly profileId: string | null;
  readonly settings: ProfileSelection['settings'] | null;
  contextWindow(model: ModelRef): number | null;
};

export type DirectApplication = {
  readonly host: DirectHost;
  readonly principal: Principal;
  /** Non-interactive policy for one attached session; its answer still goes through the wire. */
  headlessPolicy(sessionId: string, autoApprove: boolean, signal: AbortSignal): HeadlessApprovalDecider;
  /** Canonical workspace of a direct session, for clients whose snapshot has none. */
  sessionRoot(principal: Principal, sessionId: string): Promise<string>;
  /** Copies a session this mode may run into a new one, without opening the source. Returns the new id. */
  forkSession(sourceId: string): Promise<string>;
  /** `undefined` clears it. Throws if another write got there first. */
  setGoal(sessionId: string, goal: DurableGoal | undefined, source: 'user' | 'launcher'): Promise<void>;
  /** The durable goal of a session, and whether one is set at all. */
  goal(sessionId: string): Promise<DurableGoal | undefined>;
  /** Pass a snapshot's `seq` to read that cut rather than the log's current end. */
  sessionDetails(sessionId: string, seq?: number | null): DirectSessionDetails;
  close(): Promise<void>;
};

type LogLine = { readonly at: string; readonly seq: number };

/**
 * The accepted times, read from the lines themselves. `seq` pins `updatedAt` to
 * the caller's snapshot, so a newer append cannot overtake that cut. A torn last
 * line was never accepted, and it is the only line that can fail to parse.
 */
function logTimes(logPath: string, seq?: number | null): { readonly first: LogLine; readonly last: LogLine } {
  const parsed = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .flatMap((line): LogLine[] => {
      try {
        return line ? [JSON.parse(line) as LogLine] : [];
      } catch {
        return [];
      }
    });
  const first = parsed[0];
  if (!first) throw new Error(`Direct log has no accepted lines: ${logPath}`);
  const reached = parsed.filter((line) => seq === undefined || seq === null || line.seq <= seq);
  return { first, last: reached[reached.length - 1] ?? first };
}

export async function createDirectApplication(options: DirectApplicationOptions): Promise<DirectApplication> {
  const { selection, sessionBinding } = options;
  const hooks = options.hooks ? await startDirectHooks(options.hooks, selection) : null;
  const runtimes = createDirectRuntimes(
    {
      ...options,
      canRun: (workspace) => authority.canRun(workspace),
      async rollover(sessionId, request) {
        const state = stateOf(await store.open(sessionId));
        const binding = sessionStart(options.conversationsDir, sessionId).binding;
        return rollSessionOver({
          sessionId,
          state,
          ...(request ? { request } : {}),
          create: () =>
            runtimes.inheriting(sessionId, () =>
              store.create(state.workspace, state.model, binding, { rolloverFrom: sessionId }),
            ),
          carryGoal: (successor, goal) => writeGoal(successor, goal, 'launcher'),
        });
      },
    },
    hooks,
  );
  const store = createDirectSessionStore({
    directory: options.conversationsDir,
    resolveWorkspace: (root, identity) => authority.resolveStored(root, identity),
    createRuntime: (context) => runtimes.create(context),
  });
  const authority = typeof options.authority === 'function' ? options.authority(store) : options.authority;
  const create = authority.createSession ?? store.create;
  const sessions: DirectLocalStore = {
    ...store,
    create: (workspace, model, binding = sessionBinding) => create(workspace, model, binding),
    open: (id, binding = sessionBinding) => store.open(id, binding),
  };
  const host = createDirectInProcessHost({
    sessions,
    defaultModel: selection.settings.get('agent.modelSelection') as ModelRef,
    authorize: (principal, access) => authority.authorize(principal, access),
    resolveWorkspace: (principal, grant) => authority.resolveGrant(principal, grant),
    capabilities: (session) => applicationCapabilities(store, runtimes, options.conversationsDir, session),
  });
  return {
    host,
    principal: LOCAL_PRINCIPAL,
    headlessPolicy: (sessionId, autoApprove, signal) =>
      headlessPolicy({ store, runtimes, directory: options.conversationsDir, sessionId, autoApprove, signal }),
    async sessionRoot(principal, sessionId) {
      const { sessions } = await host.listSessions(principal);
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session) throw new DirectProtocolError('not_found', 'Unknown direct session.');
      return session.workspace.root;
    },
    async forkSession(sourceId) {
      const { id } = await forkDirectConversation({
        directory: options.conversationsDir,
        sourceId,
        ...(sessionBinding ? { expectedBinding: sessionBinding } : {}),
        // Refused here, or the copy would exist and then fail to open.
        async resolveWorkspace(root, identity?: Workspace) {
          const workspace = await authority.resolveStored(root, identity);
          if (!authority.canRun(workspace)) throw new Error('fork source belongs to a different workspace');
          return workspace;
        },
      });
      return id;
    },
    async setGoal(sessionId, goal, source) {
      writeGoal(await store.open(sessionId), goal, source);
    },
    goal: async (sessionId) => stateOf(await store.open(sessionId)).context.goal.goal,
    sessionDetails(sessionId, seq) {
      const logPath = path.join(options.conversationsDir, `${sessionId}.jsonl`);
      const record = runtimes.get(sessionId);
      const { first, last } = logTimes(logPath, seq);
      return {
        createdAt: first.at,
        updatedAt: last.at,
        earliestSeq: first.seq,
        logPath,
        profileId: record?.profileId ?? null,
        settings: record?.settings ?? null,
        contextWindow: ({ provider, model }) => getModelContextWindow(provider, model) ?? null,
      };
    },
    async close() {
      try {
        await host.dispose();
      } finally {
        await hooks?.close();
      }
    },
  };
}

function stateOf(session: DirectSession): DirectSessionState {
  const { state, unsubscribe } = session.capture(() => undefined);
  unsubscribe();
  return state;
}

function writeGoal(session: DirectSession, goal: DurableGoal | undefined, source: 'user' | 'launcher'): void {
  if (!session.setGoal(stateOf(session).context.goal.generation, goal, source)) {
    throw new Error('The goal changed while updating it.');
  }
}

/**
 * `reset` is a new session in the same workspace, not a change to this one: the
 * old log stays intact and other clients stay attached to it. It keeps the old
 * session's owner and its goal, which `/clear` always retained. Waiting for the
 * current turn is the caller's job, as it is for the old `/clear`.
 */
function applicationCapabilities(
  store: DirectLocalStore,
  runtimes: DirectRuntimes,
  directory: string,
  session: DirectSession,
): DirectCommandCapabilities {
  return {
    // Guards are rebuilt from the Session's own snapshot on every call.
    preview: createDirectInputPreview({ snapshot: (request) => session.snapshotInputPreview(request) }).preview,
    async reset() {
      const state = stateOf(session);
      if (state.activeTurnId !== null) throw new DirectProtocolError('rejected', 'Stop the running turn first.');
      const binding = sessionStart(directory, session.id).binding;
      const next = await runtimes.inheriting(session.id, () => store.create(state.workspace, state.model, binding));
      const { goal } = state.context.goal;
      if (goal) writeGoal(next, goal, 'launcher');
      return { sessionId: next.id };
    },
    async controlTask(taskId, action) {
      const tasks = runtimes.get(session.id)?.tasks();
      if (!tasks) throw new DirectProtocolError('unavailable', 'This session has no live runtime.');
      if (action === 'cancel') return tasks.requestStop(taskId);
      if (action === 'background') return tasks.moveToBackground(taskId);
      throw new DirectProtocolError('unavailable', `Task ${action} is not available in the direct executable yet.`);
    },
  };
}

type HeadlessPolicyInput = {
  readonly store: DirectLocalStore;
  readonly runtimes: DirectRuntimes;
  readonly directory: string;
  readonly sessionId: string;
  readonly autoApprove: boolean;
  readonly signal: AbortSignal;
};

/**
 * The existing approval policy needs the accepted history, which no client may
 * see, so it runs here. This only reads: the decision returns to the client,
 * which answers through the Session like every other client.
 */
function headlessPolicy(input: HeadlessPolicyInput): HeadlessApprovalDecider {
  const { store, runtimes, directory, sessionId, autoApprove, signal } = input;
  return async (interaction) => {
    if (interaction.kind === 'question') return decideHeadlessApproval(interaction, autoApprove);
    const runtime = runtimes.get(sessionId);
    if (!runtime) throw new Error(`No runtime for session ${sessionId}`);
    const session = await store.open(sessionId);
    const { state, unsubscribe } = session.capture(() => undefined);
    unsubscribe();
    const request = state.pendingInteractions.find((pending) => pending.requestId === interaction.requestId);
    // Already settled by cancellation. The answer this produces is reported stale.
    if (!request) return { decision: { kind: 'deny' } };
    const { history } = replay(readFacts(path.join(directory, `${sessionId}.jsonl`)));
    const decision = await runtime.scope(() =>
      untilAborted(runtime.surface.decideInteraction(request, history), signal),
    );
    return { decision, reportRejection: autoApprove };
  };
}

/** Cancellation stops waiting on advisory policy; surface disposal stops the policy itself. */
async function untilAborted(
  operation: Promise<InteractionDecision>,
  signal: AbortSignal,
): Promise<InteractionDecision> {
  const cancelled: InteractionDecision = { kind: 'deny' };
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return cancelled;
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<InteractionDecision>((resolve) => {
    onAbort = () => resolve(cancelled);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
