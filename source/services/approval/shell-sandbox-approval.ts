import { requiresDockerHostControlApproval } from '../../utils/shell/sandbox/docker-host-control-grants.js';
import type { SessionAccessState } from '../session/session-access-state.js';

export function isUnsandboxedShell(toolName: string | undefined, args: unknown): boolean {
  if (toolName !== 'shell' && toolName !== 'bash') {
    return false;
  }

  return Boolean(args && typeof args === 'object' && (args as Record<string, unknown>).sandbox === 'unsandboxed');
}

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
): boolean {
  if (toolName !== 'shell') return false;
  const command = args && typeof args === 'object' ? (args as Record<string, unknown>).command : undefined;
  return (
    typeof command === 'string' &&
    (sessionAccess
      ? sessionAccess.requiresDockerApproval(command)
      : requiresDockerHostControlApproval(sessionId, command))
  );
}

/**
 * `sessionId` scopes the Docker host-control check: a block recorded in another
 * session must not force this one through the prompt.
 */
export function requiresHumanShellApproval(
  toolName: string | undefined,
  args: unknown,
  sessionId: string | undefined,
  sessionAccess?: SessionAccessState,
): boolean {
  if (isUnsandboxedShell(toolName, args)) return true;
  const command =
    (toolName === 'shell' || toolName === 'bash') && args && typeof args === 'object'
      ? (args as Record<string, unknown>).command
      : undefined;
  return (
    typeof command === 'string' &&
    (sessionAccess
      ? sessionAccess.requiresDockerApproval(command)
      : requiresDockerHostControlApproval(sessionId, command))
  );
}
