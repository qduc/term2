/** Optional real operations not yet exposed by the native Session facade.
 * These injected domain capabilities do not create another Session/store. The owning
 * Session integration supplies them; absence always returns unavailable, never success.
 */
import type { DirectTaskControlResult } from '../session/direct-background-types.js';
import type { WireConfiguration, WireNotice, WireRewindTarget, WireContent, WireGrant, WireAnswerProvenance } from './direct-wire.js';

export type DirectCommandCapabilities = {
  /** Must validate the target and exact scope durably; never translate to ordinary allow. */
  grant?(requestId: string, grant: WireGrant, stopAfterApprovalResolution?: boolean, provenance?: WireAnswerProvenance): Promise<import('../session/direct-types.js').AnswerResult>;
  retry?(request: { readonly target: 'turn' | 'tool'; readonly executionId?: string }): Promise<void>;
  compact?(): Promise<void>;
  configure?(configuration: WireConfiguration): Promise<void>;
  controlTask?(taskId: string, action: 'cancel' | 'check_in' | 'foreground' | 'background'): Promise<DirectTaskControlResult | { readonly ok: true }>;
  listRewindTargets?(): Promise<readonly WireRewindTarget[]>;
  rewind?(targetId: string): Promise<{ readonly draft: { readonly text: string; readonly attachments: readonly WireContent[] } | null }>;
  reset?(): Promise<{ readonly sessionId: string }>;
  rollover?(): Promise<{ readonly sessionId: string }>;
  preview?(request: { readonly text: string; readonly attachments?: readonly WireContent[] }): Promise<{ readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }>;
};
