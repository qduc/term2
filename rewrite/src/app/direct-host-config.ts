/**
 * Direct host/config composition for HTTP, TUI, ACP and the app-owned server.
 *
 * Workspace grants, settings, credentials and OAuth are global. They never
 * create a Session or write a conversation fact. The app owns the one DirectHost
 * and its store; this module does not start another. Session ownership is the
 * direct-log binding `{ client: ownerUserId, id: workspaceId }`.
 * `autoApprove` and unsandboxed tools stay off. Transport secrets stay in the server verifier.
 */
export {
  DirectHostConfigError,
  directHostConfigFailure,
  isDirectHostConfigError,
  requirePrincipal,
} from './direct-host-config-error.js';
export type {
  DirectHostConfigErrorCode,
  DirectHostConfigFailure,
  DirectHostConfigSurface,
} from './direct-host-config-error.js';
export { DirectWorkspaceAuthority } from './direct-host-config-workspace.js';
export type {
  CandidateBrowse,
  CandidateSelection,
  CandidateValidation,
  DirectWorkspaceGrantInput,
  WorkspaceAlias,
  WorkspaceAuthorityResult,
  WorkspaceAccess,
} from './direct-host-config-workspace.js';
export { DirectGlobalConfiguration } from './direct-host-config-settings.js';
export type { SettingsProjection } from './direct-host-config-settings.js';
import { createAppSettings } from './settings.js';
import { createDirectAccountPorts } from './cli-account-commands.js';
import type { DirectSettingsBackend } from './direct-host-config-settings.js';

/** Compose global ports around one settings owner; never opens a Session or conversation log. */
export function createDirectProductPorts(options: { settingsDir?: string } = {}): {
  readonly settings: DirectSettingsBackend;
} & ReturnType<typeof createDirectAccountPorts> {
  const { service } = createAppSettings(options.settingsDir ? { settingsDir: options.settingsDir } : {});
  return {
    settings: {
      get: (key) => service.getDynamic(key),
      getSource: (key) => service.getSource(key),
      setPersistent: (key, value) => service.setPersistentDynamic(key, value),
      setPersistentTransaction: (changes) => service.setPersistentDynamicTransaction(changes),
      reset: (key) => service.reset(key),
    },
    ...createDirectAccountPorts(service),
  };
}
export {
  bindDirectSessionAccess,
  directAcpWorkspaces,
  directServeToolPosture,
  sessionStart,
} from './direct-host-config-access.js';
export type { DirectBoundSessionStore } from './direct-host-config-access.js';
