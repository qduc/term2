/**
 * host/ — transport and access, nothing else.
 *
 * Hands clients a `DirectConnection` to one session. The in-process host
 * (`in-process-direct.ts`, contracts in `in-process-direct-types.ts`) owns the
 * session store, sends each wire command to `protocol/direct-commands.ts` and
 * fans the projected wire events out to every attached client. The TUI, the
 * headless client, ACP and the control socket all connect through it. The HTTP
 * server (`server.ts` and its `server-*` files) exposes the same host to the
 * gateway's web client with auth, pairing and workspace admission; it never
 * drives a turn or writes conversation state itself.
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
