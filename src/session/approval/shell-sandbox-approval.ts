import type { SessionAccessState } from '../session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';

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

/**
 * Nested callers must supply their isolated compatibility state; root callers
 * use only their handle-owned access capability.
 *
 * `opts.llmMayEvaluateUnsandboxed` lifts the forced-human gate for unsandboxed
 * shell calls so the LLM auto-approval path may evaluate them. It applies only
 * when the sandbox is enabled and auto-approval is in advisory/auto mode (the
 * caller derives that from settings); it never applies to Docker host control.
 */
export function requiresHumanShellApproval(
  toolName: string | undefined,
  args: unknown,
  sessionId: string | undefined,
  sessionAccess?: SessionAccessState,
  nestedCompatibility?: NestedToolCompatibilityState,
  opts?: { llmMayEvaluateUnsandboxed?: boolean },
): boolean {
  if (isUnsandboxedShell(toolName, args) && !opts?.llmMayEvaluateUnsandboxed) return true;
  const command =
    (toolName === 'shell' || toolName === 'bash') && args && typeof args === 'object'
      ? (args as Record<string, unknown>).command
      : undefined;
  return (
    typeof command === 'string' &&
    (sessionAccess?.requiresDockerApproval(command) ??
      nestedCompatibility?.docker.requiresApproval(sessionId, command) ??
      false)
  );
}
