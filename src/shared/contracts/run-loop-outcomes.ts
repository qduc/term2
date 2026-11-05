import type { RunTerminationCause } from './run-termination.js';

/** A normal-stop policy's answer; see `ApplicationRunLoopOptions.onNormalStop`. */
export type NormalStopDecision =
  | {
      readonly action: 'stop';
      readonly terminalCause?: RunTerminationCause;
      readonly notice?: string;
      readonly diagnostics?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly action: 'continue';
      readonly reminder: string;
      readonly repairDeadline?: number;
      readonly diagnostics?: Readonly<Record<string, unknown>>;
    };

/**
 * The fate of a message handed to `steer`/`retractSteer`/`editSteer`.
 *
 * `'admitted'` — the running turn took it at a request boundary.
 * `'released'` — no further boundary is coming (turn ending, or none
 * running); the caller must send it as its own turn instead.
 * `'retracted'` — `retractSteer` pulled it out before either of the above.
 */
export type SteerOutcome = 'admitted' | 'released' | 'retracted';
