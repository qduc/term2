import type { WireEvent, WireSnapshot } from '../../protocol/direct-wire.js';
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
  readonly attachment: null | {
    readonly name: string;
    readonly socketPath: string;
    readonly discordInputEnabled: boolean;
  };
};
export type TuiStatusInfo = {
  /** Display name of the active profile, e.g. `Bare`. */
  readonly profile: string;
  readonly effort: string | undefined;
  readonly approval: 'off' | 'advisory' | 'auto' | 'always';
};
export type PickerModel = { readonly provider: string; readonly id: string; readonly name?: string };

export interface TuiIntegration {
  readonly modelPicker?: {
    favorites(sessionId: string): PickerModel[];
    list(sessionId: string): Promise<PickerModel[]>;
    toggle(sessionId: string, model: PickerModel): void;
  };
  /** Read the attached session's effective preferences on each render, including live /settings changes. */
  preferences?(sessionId: string): { readonly historySize: number; readonly pasteThreshold: number | undefined };
  /** What the attached session's status bar shows, read on each render so live /settings changes appear. */
  status?(sessionId: string): TuiStatusInfo;
  command(
    connection: TuiConnection,
    input: string,
  ): Promise<{
    readonly message?: string;
    readonly exit?: boolean;
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
  switchSession?(sessionId: string): Promise<void | { readonly message?: string }>;
}

/** App-owned TUI callbacks cross the unkeyed shell into the keyed session. */
export interface TuiProps {
  readonly connection: TuiConnection;
  readonly integration: TuiIntegration;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onSnapshot?: (snapshot: WireSnapshot) => void;
  /** New durable events only; snapshot/replay callbacks do not trigger side effects. */
  readonly onLiveEvent?: (event: WireEvent) => void;
  readonly onExit: () => void;
}
