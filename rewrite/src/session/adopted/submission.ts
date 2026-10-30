/** Live adopted submission authority; it is not a serializable session API. */
import type { UserMessage } from '../../../../source/types/message.js';
import type { InputSurgeApproval } from '../../../../source/services/input-surge-approval.js';
import { normalizeUserTurn, type UserTurn } from '../../../../source/types/user-turn.js';
import { normalizedBodyHash } from './conversation-log.js';
import type { TurnId } from '../../engine/index.js';
import type { Admission, ClientRequestId, SessionEventReference } from '../index.js';
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
export interface AdoptedSubmissionPort {
  submit(input: AdoptedSubmissionInput, options?: AdoptedSubmissionOptions): Promise<Admission>;
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
