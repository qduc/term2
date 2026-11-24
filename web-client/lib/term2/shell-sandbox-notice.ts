import type { ShellSandboxNotice } from './types';

/** The machine fact only. It does not say what Allow will do. */
export function shellSandboxMachineFact(notice: ShellSandboxNotice | undefined): string | null {
  if (!notice) return null;
  const detail = notice.detail.replace(/\s+/g, ' ').trim();
  return detail
    ? `This machine can't sandbox shell commands (${detail}).`
    : `This machine can't sandbox shell commands.`;
}
