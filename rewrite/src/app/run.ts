/**
 * Wires one headless run: surface, provider registry, log, conversation, client.
 *
 * `cli.ts` owns signals. The first signal calls `cancel()` and waits for
 * `result`, and only `result` decides the exit code. `kind: 'cancelled'` means
 * the terminal fact is durable; a failed append during cancel is `'failed'`.
 */

import type { TurnEvent } from '../engine/index.js';
import type { HeadlessEvent, HeadlessIo } from '../clients/headless/index.js';
import type { ProfileSelection } from './agent-surface.js';

export type RunRequest = {
  readonly prompt: string;
  /** Already checked by `cli.ts` (D9). */
  readonly conversationsDir: string;
  readonly selection: ProfileSelection;
  readonly io: HeadlessIo;
};

export type RunResult = { readonly kind: 'completed' | 'cancelled' | 'failed' };

export type RunHandle = {
  readonly result: Promise<RunResult>;
  /** False before the turn starts and after it ends; a signal then exits at once. */
  turnActive(): boolean;
  cancel(): void;
};

// The session's events must stay renderable by the client without either layer
// importing the other. Only app sees both, so the check lives here.
type Renderable<T extends HeadlessEvent> = T;
export type RenderedEvent = Renderable<TurnEvent>;

export function run(_request: RunRequest): RunHandle {
  throw new Error('run is not implemented yet (M1 task 5)');
}
