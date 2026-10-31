import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';

export type TuiConnection = DirectConnection | DirectReplayConnection;

/**
 * App-owned local slash commands and host/config capabilities. This must not
 * send raw slash text as a wire RPC or access Session/Engine. Unsupported
 * commands must throw; session replacement and exit belong to the app.
 */
export interface TuiIntegration {
  command(connection: TuiConnection, input: string): Promise<{ readonly message?: string; readonly exit?: boolean }>;
}
