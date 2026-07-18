export function isUnsandboxedShell(toolName: string | undefined, args: unknown): boolean {
  if (toolName !== 'shell' && toolName !== 'bash') {
    return false;
  }

  return Boolean(args && typeof args === 'object' && (args as Record<string, unknown>).sandbox === 'unsandboxed');
}

export function requiresHumanShellApproval(toolName: string | undefined, args: unknown): boolean {
  if (isUnsandboxedShell(toolName, args)) return true;
  return Boolean(
    (toolName === 'shell' || toolName === 'bash') &&
      args &&
      typeof args === 'object' &&
      (args as Record<string, unknown>).docker_host_control === true,
  );
}
