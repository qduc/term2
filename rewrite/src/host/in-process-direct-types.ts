/** Direct in-process host boundary. `Principal` and `WorkspaceGrant` live in index.ts. */
import type { DirectSession, DirectSessionState, DirectSessionStore } from '../session/facade-types.js';
import type { Principal, WorkspaceGrant } from './index.js';
import type { WireCommand, WireCommandResult, WireEvent, WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectCommandCapabilities } from '../protocol/direct-capabilities.js';

export type { Principal, WorkspaceGrant } from './index.js';
export interface DirectConnection {
  readonly sessionId: string;
  readonly snapshot: WireSnapshot;
  readonly events: AsyncIterable<WireEvent>;
  send(command: WireCommand): Promise<WireCommandResult>;
  /** Unsubscribe only; closing a connection never cancels or closes the Session. */
  close(): void;
}
/** Reconnect retains client state at replay.fromSeq. Consume tail, cut-state sync, then live.
 * snapshot is null because no current snapshot may be applied BEFORE the tail. */
export type DirectReplayConnection = Omit<DirectConnection, 'snapshot'> & {
  readonly snapshot: null;
  readonly replay: { readonly fromSeq: number; readonly toSeq: number };
};
export interface DirectHost {
  listSessions(principal: Principal, cursor?: string): ReturnType<DirectSessionStore['list']>;
  createSession(principal: Principal, grant: WorkspaceGrant): Promise<DirectConnection>;
  connect(principal: Principal, sessionId: string): Promise<DirectConnection>;
  connect(principal: Principal, sessionId: string, fromSeq: number): Promise<DirectReplayConnection>;
  /** Host shutdown owns runtime/store disposal; no persisted domain-close is implied. */
  dispose(): Promise<void>;
}
export type DirectAccess =
  | { readonly kind: 'list' }
  | { readonly kind: 'create'; readonly grant: WorkspaceGrant }
  | { readonly kind: 'read' | 'write'; readonly sessionId: string };
export type DirectHostDeps = {
  readonly sessions: DirectSessionStore;
  readonly defaultModel: DirectSessionState['model'];
  /** Required on every operation, including command sends; no implicit local/remote allow. */
  authorize(principal: Principal, access: DirectAccess): void | Promise<void>;
  /** Validates the grant and returns a workspace; no unchecked path from a client. */
  resolveWorkspace(
    principal: Principal,
    grant: WorkspaceGrant,
  ): DirectSessionState['workspace'] | Promise<DirectSessionState['workspace']>;
  /** Actual M3/M4 operations, if installed. Missing operations fail unavailable. */
  capabilities?(session: DirectSession): DirectCommandCapabilities;
};
