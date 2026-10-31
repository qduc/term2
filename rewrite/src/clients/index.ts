/**
 * clients/ — thin renderers of the protocol.
 *
 * Each client implements `Client`: headless today, and TUI, ACP and Discord
 * as they are ported. A client reads a `WireSnapshot`, folds `WireEvent`s into
 * its own view and turns user actions into `WireCommand`s. It never imports
 * session/, engine/ or below; anything it needs that the protocol lacks is a
 * protocol change.
 * Depends on: host, protocol.
 */

import type { Connection, Host, Principal } from '../host/index.js';
import type { WireEvent, WireSnapshot } from '../protocol/index.js';

export interface Client {
  readonly name: 'tui' | 'headless' | 'acp' | 'discord';
  /** Runs until the user quits or the connection ends. */
  run(host: Host, principal: Principal): Promise<void>;
}

/** Shared by clients that keep a transcript view, so each one does not re-derive it. */
export interface TranscriptView<View> {
  initial(snapshot: WireSnapshot): View;
  apply(view: View, event: WireEvent): View;
}

export type HeadlessOptions = {
  readonly prompt: string;
  /** Approval policy for unattended runs. */
  readonly onApproval: 'deny' | 'approve_low_risk' | 'approve_all';
  readonly output: 'text' | 'jsonl';
};

export type HeadlessResult = {
  readonly exitCode: number;
  readonly finalText: string;
};

export type RunHeadless = (connection: Connection, options: HeadlessOptions) => Promise<HeadlessResult>;
