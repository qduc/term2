/** Direct in-process host boundary; the bridge Host remains isolated in index.ts. */
import type { DirectSession, DirectSessionStore } from '../session/facade-types.js';
import type { ModelRef } from '../model/index.js';
import type { Workspace } from '../tools/index.js';
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
export interface DirectHost {
  listSessions(principal: Principal, cursor?: string): ReturnType<DirectSessionStore['list']>;
  createSession(principal: Principal, grant: WorkspaceGrant): Promise<DirectConnection>;
  connect(principal: Principal, sessionId: string, fromSeq?: number): Promise<DirectConnection>;
  /** Host shutdown owns runtime/store disposal; no persisted domain-close is implied. */
  dispose(): Promise<void>;
}
export type DirectAccess =
  | { readonly kind: 'list' }
  | { readonly kind: 'read' | 'write'; readonly sessionId: string };
export type DirectHostDeps = {
  readonly sessions: DirectSessionStore;
  readonly defaultModel: ModelRef;
  /** Required on every operation, including command sends; no implicit local/remote allow. */
  authorize(principal: Principal, access: DirectAccess): void | Promise<void>;
  /** Validates the grant and returns a workspace; no unchecked path from a client. */
  resolveWorkspace(principal: Principal, grant: WorkspaceGrant): Workspace | Promise<Workspace>;
  /** Actual M3/M4 operations, if installed. Missing operations fail unavailable. */
  capabilities?(session: DirectSession): DirectCommandCapabilities;
};
