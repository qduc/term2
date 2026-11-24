/** Direct host: one Session/store owner, protocol translation once, ordered multi-client fanout.
 * No adopted runtime and no fallback. Reconnect cursors require a real Session replay seam.
 */
import type { DirectSession } from '../session/facade-types.js';
import type { WireCommand } from '../protocol/wire.js';
import { applyDirectCommand } from '../protocol/commands.js';
import { DirectProtocolError } from '../protocol/errors.js';
import { directReplayView } from './in-process-direct-replay.js';
import type { DirectEventQueue } from './in-process-direct-queue.js';
import { DirectAttachment } from './in-process-direct-attachment.js';
import type {
  DirectConnection,
  DirectReplayConnection,
  DirectHost,
  DirectHostDeps,
  Principal,
  WorkspaceGrant,
} from './in-process-direct-types.js';

export type {
  DirectConnection,
  DirectReplayConnection,
  DirectHost,
  DirectHostDeps,
  Principal,
  WorkspaceGrant,
} from './in-process-direct-types.js';

/**
 * A session the principal may not read is left out of a list, not a failure of the
 * list. Grant failures come from the app's authority (DirectHostConfigError, surface
 * `authority`), matched by shape: the host does not import app code. A removed and
 * re-added root keeps its old sessions in the store's list under the new grant.
 */
function deniedByAuthority(error: unknown): boolean {
  if (error instanceof DirectProtocolError) return error.code === 'forbidden';
  return (
    error instanceof Error &&
    error.name === 'DirectHostConfigError' &&
    (error as { surface?: unknown }).surface === 'authority'
  );
}

function workspaceRoot(session: DirectSession): string {
  const capture = session.capture(() => undefined);
  try {
    return capture.state.workspace.root;
  } finally {
    capture.unsubscribe();
  }
}

/** Host owns the supplied store until dispose; each connection owns only its subscription. */
export function createDirectInProcessHost(deps: DirectHostDeps): DirectHost {
  const attachments = new Map<string, Promise<DirectAttachment>>();
  /** Every subscriber queue and its session, replay views included: they do not belong to an attachment. */
  const connections = new Map<DirectEventQueue, string>();
  const creates = new Set<Promise<DirectSession>>();
  const closingSessions = new Map<string, Promise<void>>();
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const open = (): void => {
    if (disposed) throw new DirectProtocolError('closed', 'Host is closed.');
  };

  /** Attachments whose open has finished, so a grant change can close them without waiting. */
  const settled = new WeakMap<Promise<DirectAttachment>, DirectAttachment>();

  async function attachment(id: string): Promise<DirectAttachment> {
    await closingSessions.get(id);
    open();
    let pending = attachments.get(id);
    if (!pending) {
      pending = deps.sessions.open(id).then((session) => {
        open();
        return new DirectAttachment(session);
      });
      attachments.set(id, pending);
      const original = pending;
      void pending.then(
        (attached) => settled.set(original, attached),
        () => {
          if (attachments.get(id) === original) attachments.delete(id);
        },
      );
    }
    return pending;
  }
  function connection(principal: Principal, attached: DirectAttachment): DirectConnection;
  function connection(principal: Principal, attached: DirectAttachment, fromSeq: number): DirectReplayConnection;
  function connection(
    principal: Principal,
    attached: DirectAttachment,
    fromSeq?: number,
  ): DirectConnection | DirectReplayConnection {
    open();
    const view = fromSeq === undefined ? attached.connect() : directReplayView(attached.session, fromSeq);
    if (view.events.closed) throw new DirectProtocolError('internal_error', 'Session attachment failed.');
    connections.set(view.events, attached.session.id);
    view.events.onClose = () => connections.delete(view.events);
    let closed = false;
    const result = {
      sessionId: attached.session.id,
      get snapshot() {
        return view.snapshot;
      },
      ...('replay' in view ? { replay: view.replay } : {}),
      events: view.events,
      async send(command: WireCommand): Promise<import('../protocol/wire.js').WireCommandResult> {
        if (closed || disposed || view.events.closed)
          return { ok: false, code: 'closed', message: 'Connection is closed.' };
        try {
          const readOnly =
            command.type === 'list_rewind_targets' ||
            command.type === 'preview' ||
            command.type === 'command_status' ||
            command.type === 'command_revision';
          await deps.authorize(principal, { kind: readOnly ? 'read' : 'write', sessionId: attached.session.id });
          if (closed || disposed || view.events.closed)
            return { ok: false, code: 'closed', message: 'Connection is closed.' };
          return await applyDirectCommand(attached.session, command, deps.capabilities?.(attached.session));
        } catch (error) {
          if (error instanceof DirectProtocolError) return { ok: false, code: error.code, message: error.message };
          return { ok: false, code: 'internal_error', message: 'Host command failed.' };
        }
      },
      close() {
        if (!closed) {
          closed = true;
          view.events.close();
        }
      },
    };
    return result as DirectConnection | DirectReplayConnection;
  }
  async function release(sessionId: string): Promise<void> {
    const existing = closingSessions.get(sessionId);
    if (existing) return await existing;
    const pending = attachments.get(sessionId);
    if (!pending) return;
    const closing = (async () => {
      const attached = await pending;
      try {
        await attached.session.close();
      } finally {
        attached.close();
        // Replay subscribers watch the closed Session object directly; end them too so clients reconnect.
        for (const [events, id] of [...connections]) if (id === sessionId) events.close();
        if (attachments.get(sessionId) === pending) attachments.delete(sessionId);
      }
    })();
    closingSessions.set(sessionId, closing);
    try {
      await closing;
    } finally {
      if (closingSessions.get(sessionId) === closing) closingSessions.delete(sessionId);
    }
  }
  return {
    async closeSession(principal, sessionId) {
      open();
      await deps.authorize(principal, { kind: 'write', sessionId });
      await release(sessionId);
    },
    async closeWorkspaceSessions(root) {
      open();
      // Sessions already open start closing now, so none admits a turn under the old
      // grant while the in-flight work below is awaited.
      const early = [...attachments.entries()]
        .filter(([, pending]) => {
          const attached = settled.get(pending);
          return attached !== undefined && workspaceRoot(attached.session) === root;
        })
        .map(([sessionId]) => sessionId);
      const releases = early.map((sessionId) => release(sessionId));
      // A create or open that began under the old grant settles into `attachments`; wait for it.
      await Promise.allSettled([...creates]);
      const pending = [...attachments.entries()].filter(([sessionId]) => !early.includes(sessionId));
      const opened = await Promise.allSettled(pending.map(([, attached]) => attached));
      const matching = pending.filter(([, attached], index) => {
        const result = opened[index]!;
        return result.status === 'fulfilled' && attachments.get(pending[index]![0]) === attached
          ? workspaceRoot(result.value.session) === root
          : false;
      });
      // One failed cleanup must not keep the others open; release() drops the attachment either way.
      releases.push(...matching.map(([sessionId]) => release(sessionId)));
      const closed = await Promise.allSettled(releases);
      return closed.length;
    },
    async listSessions(principal, cursor) {
      open();
      await deps.authorize(principal, { kind: 'list' });
      open();
      const page = await deps.sessions.list(cursor);
      const sessions: (typeof page.sessions)[number][] = [];
      for (const summary of page.sessions) {
        try {
          await deps.authorize(principal, { kind: 'read', sessionId: summary.id });
          sessions.push(summary);
        } catch (error) {
          if (!deniedByAuthority(error)) throw error;
        }
      }
      return { sessions, ...(page.cursor !== undefined ? { cursor: page.cursor } : {}) };
    },
    async createSession(principal, grant: WorkspaceGrant) {
      open();
      await deps.authorize(principal, { kind: 'create', grant });
      open();
      const workspace = await deps.resolveWorkspace(principal, grant);
      open();
      const pending = deps.sessions.create(workspace, deps.defaultModel);
      creates.add(pending);
      try {
        const created = await pending;
        open();
        if (attachments.has(created.id)) throw new Error('Store returned an existing session identity');
        const attached = new DirectAttachment(created);
        const ready = Promise.resolve(attached);
        settled.set(ready, attached);
        attachments.set(created.id, ready);
        return connection({ ...principal }, attached);
      } finally {
        creates.delete(pending);
      }
    },
    connect: (async (principal: Principal, sessionId: string, fromSeq?: number) => {
      open();
      await deps.authorize(principal, { kind: 'read', sessionId });
      open();
      if (fromSeq !== undefined && (!Number.isSafeInteger(fromSeq) || fromSeq < 0)) {
        throw new DirectProtocolError('invalid_command', 'Invalid durable replay cursor.');
      }
      const attached = await attachment(sessionId);
      return fromSeq === undefined
        ? connection({ ...principal }, attached)
        : connection({ ...principal }, attached, fromSeq);
    }) as DirectHost['connect'],
    dispose() {
      if (!disposal) {
        disposed = true;
        disposal = (async () => {
          await Promise.allSettled([...creates]);
          const results = await Promise.allSettled([...attachments.values()]);
          for (const result of results) if (result.status === 'fulfilled') result.value.close();
          attachments.clear();
          for (const events of [...connections.keys()]) events.close();
          await deps.sessions.close();
        })();
      }
      return disposal;
    },
  };
}
