/**
 * The control socket on an interactive session, and the two standalone control
 * clients. Discord talks only to a control socket, so it needs no host here.
 */
import { stderr, stdout } from 'node:process';
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import {
  createSessionDiscordSend,
  runControlCommand,
  runDiscordBridge,
  startDirectControlSocket,
  type ControlSessionMetadata,
  type DirectControlSocket,
  type DiscordSend,
} from '../clients/control/index.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectControlSocketRequest } from './direct-launch-types.js';

type ControlServer = DirectControlSocket['socket'];

export type DirectControlHold = { readonly drained: Promise<void>; release(): void };

/** The one socket on this process. `/bridge`, Discord send and session changes all act on it. */
export type DirectControlBridge = {
  /**
   * Discord authority for the tools of one session. It holds only while the socket
   * is bound to that session, so a session left behind by `/clear` cannot borrow
   * its successor's binding.
   */
  outbound(sessionId: string): {
    readonly discordSend: DiscordSend;
    isDiscordInputEnabled(): boolean;
  };
  readonly server: ControlServer | undefined;
  /** True when it came from the launch flag, which `/bridge disconnect` must not undo. */
  readonly isStartup: boolean;
  /** Opening a socket is optional, so failing to open one is reported, not raised. */
  attachAtStartup(sessionId: string, request: DirectControlSocketRequest): Promise<string>;
  connect(sessionId: string, name: string): Promise<ControlServer>;
  disconnect(): Promise<void>;
  /** After a real session change. A detached bridge has nothing to move. */
  rebind(sessionId: string): Promise<void>;
  /** Stops control input for a restart. The new process owns the socket name next. */
  hold(): DirectControlHold | undefined;
  close(): Promise<void>;
};

function metadataFor(app: DirectApplication, root: string): (snapshot: WireSnapshot) => ControlSessionMetadata {
  // A session's creation time never changes, and this runs on every status read.
  const details = new Map<string, ReturnType<DirectApplication['sessionDetails']>>();
  return (snapshot) => {
    const known = details.get(snapshot.sessionId) ?? app.sessionDetails(snapshot.sessionId);
    details.set(snapshot.sessionId, known);
    return {
      workspaceRoot: root,
      version: installationVersion,
      createdAt: known.createdAt,
      logPath: known.logPath,
      profileId: known.profileId,
      autoApproveMode: known.settings ? String(known.settings.get('shell.autoApproveMode')) : null,
      contextWindow: known.contextWindow(snapshot.model),
    };
  };
}

export function createDirectControlBridge(
  target: () => { readonly app: DirectApplication; readonly root: string },
): DirectControlBridge {
  let attached: DirectControlSocket | undefined;
  let boundSession: string | undefined;
  let startup = false;
  let connecting = false;

  const open = async (sessionId: string, name: string, discordInput: boolean): Promise<DirectControlSocket> => {
    const { app, root } = target();
    return startDirectControlSocket({
      host: app.host,
      principal: app.principal,
      sessionId,
      name,
      discordInput,
      metadata: metadataFor(app, root),
    });
  };

  return {
    outbound: (sessionId) => ({
      discordSend: createSessionDiscordSend(
        () => attached?.socket ?? null,
        process.env.XDG_RUNTIME_DIR ?? '',
        sessionId,
      ),
      isDiscordInputEnabled: () => boundSession === sessionId && attached?.socket.discordInputEnabled === true,
    }),
    get server() {
      return attached?.socket;
    },
    get isStartup() {
      return startup;
    },
    async attachAtStartup(sessionId, { name, discordInput }) {
      try {
        attached = await open(sessionId, name, discordInput);
        boundSession = sessionId;
        startup = true;
        return `Control socket on: ${name} (pid ${process.pid})`;
      } catch (error) {
        return `Control socket off: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    async connect(sessionId, name) {
      if (attached || connecting) throw new Error('A control socket is already connected or connecting.');
      connecting = true;
      try {
        // Asking for the bridge by name is the opt-in to Discord input, as it is today.
        attached = await open(sessionId, name, true);
        boundSession = sessionId;
        return attached.socket;
      } finally {
        connecting = false;
      }
    },
    async disconnect() {
      const closing = attached;
      attached = undefined;
      boundSession = undefined;
      await closing?.close();
    },
    async rebind(sessionId) {
      if (!attached) return;
      await attached.rebind(sessionId);
      boundSession = sessionId;
    },
    hold: () => attached?.socket.pauseMutations(),
    async close() {
      const closing = attached;
      attached = undefined;
      boundSession = undefined;
      await closing?.close();
    },
  };
}

export function launchControl(argv: readonly string[]): Promise<number> {
  return runControlCommand([...argv], stdout, stderr);
}

/** The bridge owns and awaits its own signal lifecycle, so this installs none. */
export async function launchDiscord(argv: readonly string[]): Promise<number> {
  await runDiscordBridge([...argv]);
  return 0;
}
