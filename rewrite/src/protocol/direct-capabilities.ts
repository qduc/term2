/** Optional real operations not yet exposed by the native Session facade.
 * These injected domain capabilities do not create another Session/store. The owning
 * Session integration supplies them; absence always returns unavailable, never success.
 */
import type { DirectTaskControlResult } from '../session/direct-background-types.js';
import type { WireNotice, WireContent, WireGrant, WireAnswerProvenance } from './direct-wire.js';

export type DirectCommandCapabilities = {
  /** Must validate the target and exact scope durably; never translate to ordinary allow. */
  grant?(
    requestId: string,
    grant: WireGrant,
    stopAfterApprovalResolution?: boolean,
    provenance?: WireAnswerProvenance,
  ): Promise<import('../session/direct-types.js').AnswerResult>;
  controlTask?(
    taskId: string,
    action: 'cancel' | 'check_in' | 'foreground' | 'background',
  ): Promise<DirectTaskControlResult | { readonly ok: true }>;
  reset?(): Promise<{ readonly sessionId: string }>;
  preview?(request: {
    readonly text: string;
    readonly attachments?: readonly WireContent[];
  }): Promise<{ readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }>;
};
