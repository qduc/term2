import { projection } from '../protocol/projection.js';
import { applyCommand } from '../protocol/commands.js';
import type { WireEvent } from '../protocol/index.js';
import type { Session, SessionId } from '../session/index.js';
import type { Connection, Host, HostDeps, InProcessHostFactory } from './index.js';

/** The host the TUI would use: same `Connection` contract as the server, no network. */
export const createInProcessHost: InProcessHostFactory = (deps: HostDeps): Host => {
  const open = new Map<string, Promise<Session>>();
  const session = (id: string): Promise<Session> => {
    let pending = open.get(id);
    if (!pending) {
      pending = deps.sessions.open(id as SessionId);
      open.set(id, pending);
    }
    return pending;
  };

  return {
    async listSessions() {
      const page = await deps.sessions.list();
      return {
        sessions: page.sessions.map((summary) => ({
          id: summary.id,
          title: summary.title,
          updatedAt: summary.updatedAt,
        })),
        nextCursor: page.nextCursor,
      };
    },
    async createSession(_principal, grant) {
      const created = await deps.sessions.create(
        { root: deps.resolveWorkspace(grant), access: grant.access, target: 'local' },
        deps.defaultModel,
      );
      open.set(created.id, Promise.resolve(created));
      return connection(created);
    },
    async connect(_principal, sessionId, fromSeq) {
      return connection(await session(sessionId), fromSeq);
    },
  };
};

function connection(session: Session, fromSeq?: number): Connection {
  const snapshot = projection.snapshot(session.id, session.state());
  const queue: WireEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const unsubscribe = session.subscribe(fromSeq ?? snapshot.seq, (update) => {
    const event = projection.toWire(session.id, update);
    if (!event) return;
    queue.push(event);
    wake?.();
  });

  async function* events(): AsyncGenerator<WireEvent> {
    while (!closed) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
    }
  }

  return {
    sessionId: session.id,
    snapshot,
    events: events(),
    send: (command) => applyCommand(session, command),
    close() {
      closed = true;
      unsubscribe();
      wake?.();
    },
  };
}
