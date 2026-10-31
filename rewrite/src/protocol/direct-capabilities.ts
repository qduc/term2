/** Optional real operations not yet exposed by the minimal M2 facade.
 * These injected domain capabilities do not create another Session/store. The owning
 * Session integration supplies them; absence always returns unavailable, never success.
 */
import type { DirectTaskControlResult } from '../session/direct-background-types.js';
import type { DirectQueueMutation } from '../session/direct-queue-types.js';
import type { DirectAdmission, DirectSubmission } from '../session/facade-types.js';
import type { WireConfiguration, WireNotice, WireRewindTarget, WireContent, WireGrant } from './direct-wire.js';

export type DirectCommandCapabilities = {
  submitWithDelivery?(request: DirectSubmission, delivery: 'steer' | 'follow_up' | 'reject_if_busy'): Promise<DirectAdmission>;
  /** Must validate the target and exact scope durably; never translate to ordinary allow. */
  grant?(requestId: string, grant: WireGrant, stopAfterApprovalResolution?: boolean): Promise<import('../session/direct-types.js').AnswerResult>;
  /** Must compare and cancel under Session admission ownership, never capture-then-cancel. */
  cancelForeground?(expectedTurnId: string): Promise<{ readonly kind: 'accepted' | 'stale' }>;
  retry?(request: { readonly target: 'turn' | 'tool'; readonly executionId?: string }): Promise<void>;
  compact?(): Promise<void>;
  configure?(configuration: WireConfiguration): Promise<void>;
  // Omitted attachments retains the original attachments; [] explicitly clears them.
  editQueue?(messageId: string, edit: { readonly text: string; readonly attachments?: readonly WireContent[] }): Promise<DirectQueueMutation>;
  retractQueue?(messageId: string): Promise<DirectQueueMutation>;
  resumeQueue?(): Promise<DirectQueueMutation>;
  discardQueue?(): Promise<DirectQueueMutation>;
  controlTask?(taskId: string, action: 'cancel' | 'check_in' | 'foreground' | 'background'): Promise<DirectTaskControlResult | { readonly ok: true }>;
  listRewindTargets?(): Promise<readonly WireRewindTarget[]>;
  rewind?(targetId: string): Promise<{ readonly draft: { readonly text: string; readonly attachments: readonly WireContent[] } | null }>;
  reset?(): Promise<{ readonly sessionId: string }>;
  rollover?(): Promise<{ readonly sessionId: string }>;
  preview?(request: { readonly text: string; readonly attachments?: readonly WireContent[] }): Promise<{ readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }>;
};
