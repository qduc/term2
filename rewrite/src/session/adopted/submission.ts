/** Live adopted submission authority; it is not a serializable session API. */
import type { decideInteraction } from '../../../../source/gateway/interaction-protocol.js';
import type { UserMessage } from '../../../../source/types/message.js';
import type { InputSurgeApproval } from '../../../../source/services/input-surge-approval.js';
import { normalizeUserTurn, type UserTurn } from '../../../../source/types/user-turn.js';
import { normalizedBodyHash } from './conversation-log.js';
import type { TurnId } from '../../engine/index.js';
import type { ToolCallId } from '../../model/index.js';
import type { Admission, ClientRequestId, InteractionId, SessionEventReference } from '../index.js';
import type { SessionDriverContext } from '../local-store.js';

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
export interface AdoptedSubmissionPort {
  submit(input: AdoptedSubmissionInput, options?: AdoptedSubmissionOptions): Promise<Admission>;
  decide(command: AdoptedInteractionCommand): Promise<void>;
  retry(target: AdoptedRetryTarget): Promise<AdoptedRetryResult>;
  interruptFromUser(): Promise<void>;
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
