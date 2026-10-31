/** Headless public types. Intent is expressed only through the direct wire contract. */
import type {
  WireContent,
  WireDecision,
  WireInteraction,
  WireOrigin,
  WireSubmission,
} from '../../protocol/direct-wire.js';

/**
 * Renders one M1 turn. Structural types only, because clients may not import
 * session/ or engine/.
 *
 * `{ type: string }` keeps the union open, so a discriminant check does not
 * narrow it; use `'delta' in event` or `'result' in event`.
 */
export type HeadlessEvent =
  | { readonly type: 'text_delta'; readonly delta: string }
  | {
      readonly type: 'turn_ended';
      readonly result: { readonly kind: string; readonly error?: { readonly message: string } };
    }
  | { readonly type: string };

export type HeadlessIo = {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
};

export type HeadlessOutput = 'plain' | 'json';

/** A wire decision plus whether the non-interactive presenter must report the rejection. */
export type HeadlessDecision = {
  readonly decision: WireDecision;
  readonly reportRejection?: boolean;
};

export type HeadlessApprovalDecider = (interaction: WireInteraction) => HeadlessDecision | Promise<HeadlessDecision>;

export type DirectHeadlessOptions = {
  readonly prompt: string;
  /** `plain` streams answer text; `json` is gated until the protocol read model exists. */
  readonly output?: HeadlessOutput;
  /** The old `--auto-approve`: tool approvals only, never questions or run check-ins. */
  readonly autoApprove?: boolean;
  /** Old `showReasoning`: reasoning deltas go to stderr; never to stdout. */
  readonly showReasoning?: boolean;
  /** Old `quiet`: suppress non-error stderr event lines; errors and verdicts still show. */
  readonly quiet?: boolean;
  readonly io?: HeadlessIo;
  /** Defaults to `{kind:'cli'}` so Session can attribute the submission. */
  readonly origin?: WireOrigin;
  /** Raw padded RFC4648 base64 image parts; the client never reads paths or data URIs. */
  readonly attachments?: readonly WireContent[];
  /**
   * Omitted means the Session's actual default. Explicit modes other than
   * `auto` need the real `submitWithDelivery` capability; absence is reported,
   * never retried or faked.
   */
  readonly delivery?: WireSubmission['delivery'];
  /** Supplied by the app when it needs an idempotency key; otherwise generated. */
  readonly requestId?: string;
  /** Exact `--resume` target. A different attached session is refused before submit. */
  readonly expectedSessionId?: string;
  /** The one-shot CLI's cancellation source; an abort sends `cancel`, never a process exit. */
  readonly signal?: AbortSignal;
  /** App-composed policy. When absent, the conservative headless policy below is used. */
  readonly decideApproval?: HeadlessApprovalDecider;
  /** Fields merged into the old `--json` `session_start` record (profile metadata). */
  readonly profileMetadata?: Readonly<Record<string, unknown>>;
  /** Old `agent.backgroundWaitTimeoutMs`; defaults to one hour. */
  readonly backgroundWaitTimeoutMs?: number;
  /** Default true: a finished one-shot run detaches its connection, not the session. */
  readonly closeConnection?: boolean;
};

export type DirectHeadlessOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'context_paused'
  | 'blocked'
  | 'budget_paused'
  | 'error';

export type DirectHeadlessResult = {
  /** 0 completed, 1 ordinary failure or cancellation, 2 a resumable context/goal stop. */
  readonly exitCode: number;
  readonly outcome: DirectHeadlessOutcome;
  /** Answer text as the old headless final text; empty when the turn produced none. */
  readonly finalText: string;
  readonly sessionId: string;
  /** Null when the run ended before a turn was identified. */
  readonly turnId: string | null;
};
