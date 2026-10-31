import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';

import type { WireContent } from '../../protocol/direct-wire.js';

export type TuiConnection = DirectConnection | DirectReplayConnection;

/**
 * App-owned local slash commands and host/config capabilities. This must not
 * send raw slash text as a wire RPC or access Session/Engine. Unsupported
 * commands must throw; session replacement and exit belong to the app.
 */
export type BridgeStatus = {
  readonly sessionId: string;
  readonly startup: boolean;
  readonly attachment: null | { readonly name: string; readonly socketPath: string; readonly discordInputEnabled: boolean };
};
export interface TuiIntegration {
  command(connection: TuiConnection, input: string): Promise<{
    readonly message?: string; readonly exit?: boolean;
    readonly draft?: { readonly text: string; readonly attachments: readonly WireContent[] };
    readonly sessionId?: string;
  }>;
  /** App owns socket lifecycle and returns the current actual attachment state. */
  readonly bridge?: {
    status(): Promise<BridgeStatus>;
    connect(name: string): Promise<BridgeStatus>;
    disconnect(): Promise<BridgeStatus>;
  };
  /** Attach a returned direct session ID; do not reuse the previous connection. */
  switchSession?(sessionId: string): Promise<void>;
}
