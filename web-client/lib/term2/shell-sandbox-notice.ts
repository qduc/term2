import type { ShellSandboxNotice } from './types';

/**
 * Card copy for a pending shell approval. The machine fact is only why the
 * sandbox cannot run. Whether this command would be isolated comes from the
 * request and the settings the client already has.
 */
export function shellSandboxApprovalCopy(input: {
  notice: ShellSandboxNotice | undefined;
  sandboxSetting: 'enabled' | 'disabled' | 'unavailable' | undefined;
  workspaceAccess: 'read' | 'read_write' | undefined;
  argumentsText: string;
  sshEnabled: boolean;
}): string | null {
  const notice = input.notice;
  if (!notice) return null;
  const detail = notice.detail.replace(/\s+/g, ' ').trim();
  const parenthetical = detail && !/not run|retry/i.test(detail) ? ` (${detail})` : '';
  const depending = `Shell sandbox unavailable on this machine${parenthetical}. Commands approved here run without sandbox isolation or are refused, depending on the request.`;
  if (input.workspaceAccess !== 'read_write') return depending;
  const mode = sandboxMode(input.argumentsText);
  const bare =
    mode === 'unsandboxed' ||
    input.sandboxSetting === 'disabled' ||
    input.sshEnabled ||
    notice.code === 'disabled';
  if (bare) return 'This command will run without sandbox isolation.';
  if (mode === 'unknown' || input.sandboxSetting === undefined || input.sandboxSetting === 'unavailable') return depending;
  return `This machine can't sandbox shell commands${parenthetical}. Allowing will be refused unless the command is run unsandboxed.`;
}

function sandboxMode(argumentsText: string): 'default' | 'unsandboxed' | 'unknown' {
  try {
    const parsed = JSON.parse(argumentsText) as { sandbox?: unknown };
    if (!parsed || typeof parsed !== 'object') return 'unknown';
    if (parsed.sandbox === undefined) return 'default';
    if (parsed.sandbox === 'default' || parsed.sandbox === 'unsandboxed') return parsed.sandbox;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
