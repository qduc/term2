import type { Connection } from '../../host/index.js';
import type { WireEvent, WireSnapshot } from '../../protocol/index.js';
import type { TuiState, ViewUpdate } from './state.js';

/**
 * Integration seam for C4: translate its final snapshot/events to view data and
 * route UI actions through its typed wire commands or app-owned host/config
 * capabilities. No implementation of this interface may call Session or Engine.
 * Snapshot must include all display state at the connection's atomic cut; event
 * mapping must preserve order and associate final messages with their draft IDs.
 */
export interface TuiIntegration {
  snapshot(snapshot: WireSnapshot): TuiState;
  event(event: WireEvent): readonly ViewUpdate[];
  /** A rejection or unsupported operation must be returned as an error. */
  submit(connection: Connection, text: string): Promise<void>;
  cancel(connection: Connection): Promise<void>;
  answer(connection: Connection, interactionId: string, choiceId: string, text?: string): Promise<void>;
  /** Map the existing slash-command vocabulary to typed wire or host actions. */
  command(connection: Connection, input: string): Promise<{ readonly message?: string; readonly exit?: boolean }>;
}
