/**
 * host/ — transport and access, nothing else.
 *
 * Hands clients a `Connection` to a session. The in-process host is what
 * the TUI uses; the server host exposes the same contract over HTTP for the
 * web client, ACP and Discord. Auth, pairing and workspace admission live
 * here; turn logic does not.
 * Depends on: protocol, session, config.
 */

import type { WireCommand, WireCommandResult, WireEvent, WireSnapshot } from '../protocol/index.js';
import type { SessionStore } from '../session/index.js';
import type { SettingsSource } from '../config/index.js';

export type Principal = {
  readonly userId: string;
  /** 'local' for the in-process host, otherwise how the caller authenticated. */
  readonly via: 'local' | 'paired_device' | 'assertion';
};

export type WorkspaceGrant = {
  readonly workspaceId: string;
  readonly access: 'read' | 'read_write';
};

export interface Connection {
  readonly sessionId: string;
  readonly snapshot: WireSnapshot;
  /** Events after `snapshot.seq`, then live. Ends when the connection closes. */
  readonly events: AsyncIterable<WireEvent>;
  send(command: WireCommand): Promise<WireCommandResult>;
  close(): void;
}

export interface Host {
  listSessions(principal: Principal, cursor?: string): Promise<{
    readonly sessions: readonly { readonly id: string; readonly title: string | null; readonly updatedAt: string }[];
    readonly nextCursor: string | null;
  }>;
  createSession(principal: Principal, grant: WorkspaceGrant): Promise<Connection>;
  /** `fromSeq` lets a reconnecting client skip what it already has. */
  connect(principal: Principal, sessionId: string, fromSeq?: number): Promise<Connection>;
}

export type HostDeps = {
  readonly sessions: SessionStore;
  readonly settings: SettingsSource;
};

export type InProcessHostFactory = (deps: HostDeps) => Host;

export type ServerHostOptions = {
  readonly listen: { readonly host: string; readonly port: number };
  readonly allowedWorkspaces: readonly { readonly id: string; readonly root: string; readonly access: 'read' | 'read_write' }[];
};

export interface ServerHost extends Host {
  start(): Promise<{ readonly url: string }>;
  stop(): Promise<void>;
}

export type ServerHostFactory = (deps: HostDeps, options: ServerHostOptions) => ServerHost;
