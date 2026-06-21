export function isUnsandboxedShell(toolName: string | undefined, args: unknown): boolean {
  if (toolName !== 'shell' && toolName !== 'bash') {
    return false;
  }

  return Boolean(args && typeof args === 'object' && (args as Record<string, unknown>).sandbox === 'unsandboxed');
}
