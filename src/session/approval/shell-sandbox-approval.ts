import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';

/**
 * Whether this approval is the Docker host-control capability prompt.
 *
 * Single source of truth: the descriptor the UI renders from and the gate that
 * decides which answer may resume the tool call must agree, or the request
 * stalls on approval forever.
 */
export function isDockerHostControlShellApproval(
  toolName: string | undefined,
  args: unknown,
  sessionId: string | undefined,
  sessionAccess?: SessionAccessState,
  nestedCompatibility?: NestedToolCompatibilityState,
): boolean {
  if (toolName !== 'shell') return false;
  const command = args && typeof args === 'object' ? (args as Record<string, unknown>).command : undefined;
  return (
    typeof command === 'string' &&
    (sessionAccess?.requiresDockerApproval(command) ??
      nestedCompatibility?.docker.requiresApproval(sessionId, command) ??
      false)
  );
}
