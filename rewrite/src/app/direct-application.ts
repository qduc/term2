/**
 * The direct application: one store, one in-process host and the runtime each
 * session needs. Every mode is a client of this host. Only `host.dispose()` ends
 * Sessions, so a client disconnecting never stops work another client can see.
 */
import path from 'node:path';
import { createDirectInProcessHost } from '../host/in-process-direct.js';
import type { DirectHost, Principal } from '../host/in-process-direct-types.js';
import type { HeadlessApprovalDecider } from '../clients/headless/index.js';
import { decideHeadlessApproval } from '../clients/headless/index.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import type { DirectCommandCapabilities } from '../protocol/direct-capabilities.js';
import { createDirectSessionStore, type DirectLocalStore } from '../session/direct-store.js';
import type { DirectSession } from '../session/facade-types.js';
import { readFacts } from '../session/log.js';
import { replay } from '../session/replay.js';
import type { InteractionDecision } from '../engine/index.js';
import type { ModelRef } from '../model/index.js';
import { createDirectRuntimes, type DirectRuntimeOptions, type DirectRuntimes } from './direct-application-runtime.js';
import { LOCAL_PRINCIPAL, type DirectAuthority } from './direct-application-workspaces.js';

export type DirectApplicationOptions = DirectRuntimeOptions & {
  readonly conversationsDir: string;
  readonly authority: DirectAuthority;
};

export type DirectApplication = {
  readonly host: DirectHost;
  readonly principal: Principal;
  /** Non-interactive policy for one attached session; its answer still goes through the wire. */
  headlessPolicy(sessionId: string, autoApprove: boolean, signal: AbortSignal): HeadlessApprovalDecider;
  /** Canonical workspace of a direct session, for clients whose snapshot has none. */
  sessionRoot(principal: Principal, sessionId: string): Promise<string>;
  close(): Promise<void>;
};

export function createDirectApplication(options: DirectApplicationOptions): DirectApplication {
  const { authority, selection } = options;
  const runtimes = createDirectRuntimes(options);
  const store = createDirectSessionStore({
    directory: options.conversationsDir,
    resolveWorkspace: (root) => authority.resolveStored(root),
    createRuntime: (context) => runtimes.create(context),
  });
  const host = createDirectInProcessHost({
    sessions: store,
    defaultModel: selection.settings.get('agent.modelSelection') as ModelRef,
    authorize: (principal, access) => authority.authorize(principal, access),
    resolveWorkspace: (principal, grant) => authority.resolveGrant(principal, grant),
    capabilities: (session) => applicationCapabilities(store, session),
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
    close: () => host.dispose(),
  };
}

/**
 * `reset` is a new session in the same workspace, not a change to this one: the
 * old log stays intact and other clients stay attached to it. Waiting for the
 * current turn is the caller's job, as it is for the old `/clear`.
 */
function applicationCapabilities(store: DirectLocalStore, session: DirectSession): DirectCommandCapabilities {
  return {
    async reset() {
      const { state, unsubscribe } = session.capture(() => undefined);
      unsubscribe();
      if (state.activeTurnId !== null) throw new DirectProtocolError('rejected', 'Stop the running turn first.');
      const next = await store.create(state.workspace, state.model);
      return { sessionId: next.id };
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
    const surface = runtimes.surface(sessionId);
    if (!surface) throw new Error(`No runtime for session ${sessionId}`);
    const session = await store.open(sessionId);
    const { state, unsubscribe } = session.capture(() => undefined);
    unsubscribe();
    const request = state.pendingInteractions.find((pending) => pending.requestId === interaction.requestId);
    // Already settled by cancellation. The answer this produces is reported stale.
    if (!request) return { decision: { kind: 'deny' } };
    const { history } = replay(readFacts(path.join(directory, `${sessionId}.jsonl`)));
    const decision = await runtimes.scope(sessionId)(() =>
      untilAborted(surface.decideInteraction(request, history), signal),
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
