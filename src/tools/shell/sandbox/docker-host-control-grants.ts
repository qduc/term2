import type { ISettingsService } from '../../../shared/service-interfaces.js';
export type DockerHostControlGrant = 'once' | 'session' | 'project';
type DockerHostControlGrantRequest = {
  command: string;
  cwd: string;
  scope: DockerHostControlGrant;
  sessionId: string;
};
/** Narrow capability grant store. Persistence is intentionally limited to user settings. */
export interface DockerHostControlGrants {
  /**
   * A sandboxed run of this command was blocked from the Docker daemon.
   *
   * Scoped to the session that hit the block: the record is what later grants a
   * command host control, so another session must not inherit it. A run with no
   * session identity cannot be attributed, so it is dropped rather than recorded
   * globally — the command stays sandboxed instead of gaining unearned access.
   */
  recordDenial(sessionId: string | undefined, command: string): void;
  consumeDenial(sessionId: string | undefined, command: string): boolean;
  hasDenial(sessionId: string | undefined, command: string): boolean;
  requiresApproval(sessionId: string | undefined, command: string): boolean;
  configure(settings: ISettingsService): void;
  grant({ command, cwd, scope, sessionId }: DockerHostControlGrantRequest): void;
  consumeOnce(sessionId: string, command: string): boolean;
  hasSession(sessionId: string, cwd: string): boolean;
  hasProject(cwd: string): boolean;
  grantProject(cwd: string): void;
  clearSession(sessionId: string): void;
  resetForTests(): void;
}
