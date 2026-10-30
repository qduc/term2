import type {
  RuntimeSettingMutation,
  RuntimeSettingsSnapshot,
} from '../../../../source/services/settings/session-runtime-settings.js';
/** Live adopted submission authority; it is not a serializable session API. */
import type { decideInteraction } from '../../../../source/gateway/interaction-protocol.js';
import type { UserMessage } from '../../../../source/types/message.js';
import type { InputSurgeApproval } from '../../../../source/services/input-surge-approval.js';
import { normalizeUserTurn, type UserTurn } from '../../../../source/types/user-turn.js';
import { normalizedBodyHash } from './conversation-log.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import type { TurnId } from '../../engine/index.js';
import type { ToolCallId } from '../../model/index.js';
import type {
  Admission,
  ClientRequestId,
  InteractionId,
  LogEntry,
  SessionEventReference,
  SessionFact,
} from '../index.js';
import type { SessionDriverContext } from '../local-store.js';
import type { TurnControl } from './turn-control.js';

export interface AdoptedSubmissionInput {
  readonly requestId: ClientRequestId;
  readonly input: UserTurn;
}
export interface AdoptedAdmissionReceipt {
  readonly requestId: ClientRequestId;
  readonly turnId: TurnId;
  readonly userMessageRef: SessionEventReference;
  readonly input: UserTurn;
}
export interface AdoptedSubmissionOptions {
  readonly inputSurgeApproval?: InputSurgeApproval;
}
export type AdoptedInteractionIdentity = {
  readonly turnId: TurnId;
  readonly interactionId: InteractionId;
  readonly revision: number;
  readonly generation: string;
};
export type AdoptedInteractionCommand = AdoptedInteractionIdentity &
  (
    | {
        readonly kind: 'choose';
        readonly decisions: readonly {
          readonly callId?: ToolCallId;
          readonly choice: Parameters<typeof decideInteraction>[1];
        }[];
      }
    | { readonly kind: 'navigate'; readonly direction: 'previous' | 'next' }
  );
export type AdoptedRetryTarget = 'turn' | 'tool';
export type AdoptedRetryResult =
  | { readonly kind: 'started'; readonly turnId: TurnId }
  | { readonly kind: 'ineligible'; readonly target: AdoptedRetryTarget }
  | { readonly kind: 'rejected'; readonly reason: 'closed' };
export type HistoryMutation =
  | { readonly kind: 'undo_last' }
  | { readonly kind: 'undo_count'; readonly count: number }
  | { readonly kind: 'rewind'; readonly targetId: string };
export type HistoryMutationResult =
  | { readonly kind: 'applied'; readonly restored: { text: string; images?: UserTurn['images'] } }
  | { readonly kind: 'not_found' | 'stale' };
export interface AdoptedSubmissionPort {
  history(command: HistoryMutation): Promise<HistoryMutationResult>;
  listRewindTargets(): Promise<
    readonly import('../../../../source/services/conversation/conversation-store.js').RewindTarget[]
  >;
  submit(input: AdoptedSubmissionInput, options?: AdoptedSubmissionOptions): Promise<Admission>;
  decide(command: AdoptedInteractionCommand): Promise<void>;
  retry(target: AdoptedRetryTarget): Promise<AdoptedRetryResult>;
  interruptFromUser(): Promise<void>;
  setRuntimeSettings(
    command: RuntimeSettingMutation,
  ): Promise<{ kind: 'applied'; settings: RuntimeSettingsSnapshot } | { kind: 'unsupported' }>;
  readonly networkApproval?: Pick<
    ReturnType<typeof import('./network-authority.js').createNetworkAuthority>,
    'getSnapshot' | 'subscribe' | 'decide'
  >;
}
export interface AdoptedAdmissionContext extends SessionDriverContext {
  admit(
    input: AdoptedSubmissionInput,
    message: UserMessage,
  ): Promise<
    | { readonly kind: 'admitted'; readonly receipt: AdoptedAdmissionReceipt }
    | Extract<Admission, { kind: 'duplicate' | 'rejected' }>
  >;
  activate(receipt: AdoptedAdmissionReceipt): Promise<void>;
}

/** What the foreground hands every submission command it builds. */
export interface AdoptedCommandDeps {
  readonly context: AdoptedAdmissionContext;
  readonly runtime: SessionRuntimeInternals;
  readonly turn: TurnControl;
  /** Durably appends the buffered log events and these facts. */
  commit(facts: readonly SessionFact[]): Promise<readonly LogEntry[]>;
  /** Marks the session poisoned and returns the stored error. */
  poison(error: unknown): unknown;
}

/** Own the normalized input before any asynchronous admission work. */
export function captureAdoptedInput(input: UserTurn): { input: UserTurn; hash: string } {
  const normalized = normalizeUserTurn(input);
  const owned = {
    ...normalized,
    ...(normalized.images ? { images: normalized.images.map((image) => ({ ...image })) } : {}),
    ...(normalized.skill ? { skill: { ...normalized.skill } } : {}),
  };
  return { input: owned, hash: `adopted-user-turn-v1:${normalizedBodyHash(owned)}` };
}
