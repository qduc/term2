/**
 * Direct host/config composition for HTTP, TUI, ACP and the private server.
 *
 * Workspace grants, settings, credentials and OAuth are global. They never
 * create a Session or write a conversation fact. Serve uses one DirectHost;
 * session ownership is the direct-log binding `{ client: ownerUserId, id: workspaceId }`.
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
export { createDirectProductPorts } from './adopted/direct-host-config-product.js';
export {
  bindDirectSessionAccess,
  directAcpWorkspaces,
  directServeToolPosture,
  sessionStart,
} from './direct-host-config-access.js';
export { startDirectPrivateServer } from './direct-host-config-launch.js';
