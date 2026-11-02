/** Direct host: one Session/store owner, protocol translation once, ordered multi-client fanout.
 * No adopted runtime and no fallback. Reconnect cursors require a real Session replay seam.
 */
import type { DirectSession } from '../session/facade-types.js';
import type { WireCommand } from '../protocol/direct-wire.js';
import { applyDirectCommand } from '../protocol/direct-commands.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
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

/** Host owns the supplied store until dispose; each connection owns only its subscription. */
export function createDirectInProcessHost(deps: DirectHostDeps): DirectHost {
  const attachments = new Map<string, Promise<DirectAttachment>>();
  const connections = new Set<DirectEventQueue>();
  const creates = new Set<Promise<DirectSession>>();
  let disposed = false;
  let disposal: Promise<void> | null = null;
  const open = (): void => {
    if (disposed) throw new DirectProtocolError('closed', 'Host is closed.');
  };

  function attachment(id: string): Promise<DirectAttachment> {
    let pending = attachments.get(id);
    if (!pending) {
      pending = deps.sessions.open(id).then((session) => {
        open();
        return new DirectAttachment(session);
      });
      attachments.set(id, pending);
      const original = pending;
      void pending.catch(() => {
        if (attachments.get(id) === original) attachments.delete(id);
      });
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
    connections.add(view.events);
    view.events.onClose = () => connections.delete(view.events);
    let closed = false;
    const result = {
      sessionId: attached.session.id,
      snapshot: view.snapshot,
      ...('replay' in view ? { replay: view.replay } : {}),
      events: view.events,
      async send(command: WireCommand): Promise<import('../protocol/direct-wire.js').WireCommandResult> {
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
  return {
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
          if (!(error instanceof DirectProtocolError) || error.code !== 'forbidden') throw error;
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
        attachments.set(created.id, Promise.resolve(attached));
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
          for (const events of [...connections]) events.close();
          await deps.sessions.close();
        })();
      }
      return disposal;
    },
  };
}
