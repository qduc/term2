/**
 * host/ — transport and access, nothing else.
 *
 * Hands clients a `DirectConnection` to one session. The in-process host
 * (`in-process-direct.ts`, contracts in `in-process-direct-types.ts`) holds the
 * session store the app built with `session/store.ts` and disposes it on
 * shutdown. It sends each wire command to `protocol/commands.ts`.
 * `in-process-direct-attachment.ts` keeps one projection per session and fans
 * its wire events out, in order, to every connection to that session. The TUI,
 * the headless client, ACP and the control socket all connect through it.
 *
 * The HTTP server (`server.ts` and its `server-*` files, started by
 * `term2 serve`) exposes the same host to the gateway's web client with auth,
 * pairing and workspace admission; it never drives a turn or writes
 * conversation state itself. Web parity is deferred (#80): the agent-wire v2
 * format in `server-wire-v2.ts` stays gated off.
 * Depends on: protocol, session, config.
 */

export type Principal = {
  readonly userId: string;
  /** 'local' for the in-process host, otherwise how the caller authenticated. */
  readonly via: 'local' | 'paired_device' | 'assertion';
};

export type WorkspaceGrant = {
  readonly workspaceId: string;
  readonly access: 'read' | 'read_write';
};
