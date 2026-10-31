/** Optional real operations not yet exposed by the minimal M2 facade.
 * These injected domain capabilities do not create another Session/store. The owning
 * Session integration supplies them; absence always returns unavailable, never success.
 */
import type { WireCancelTarget, WireConfiguration, WireNotice, WireRewindTarget } from './direct-wire.js';

export type DirectCommandCapabilities = {
  retry?(request: { readonly target: 'turn' | 'tool'; readonly executionId?: string }): Promise<void>;
  compact?(): Promise<void>;
  configure?(configuration: WireConfiguration): Promise<void>;
  editQueue?(messageId: string, text: string): Promise<void>;
  retractQueue?(messageId: string): Promise<void>;
  resumeQueue?(): Promise<void>;
  discardQueue?(): Promise<void>;
  controlTask?(taskId: string, action: 'cancel' | 'check_in' | 'foreground'): Promise<void>;
  listRewindTargets?(): Promise<readonly WireRewindTarget[]>;
  rewind?(targetId: string): Promise<void>;
  reset?(): Promise<{ readonly sessionId: string }>;
  rollover?(): Promise<{ readonly sessionId: string }>;
  preview?(text: string): Promise<{ readonly notices: readonly WireNotice[]; readonly requiresConfirmation: boolean }>;
};
