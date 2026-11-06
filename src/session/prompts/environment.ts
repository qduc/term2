import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import type { ExecutionContext } from '../../tools/execution-context.js';
import { getProjectTreeForPrompt } from '../../shared/utils/project-tree.js';

/** Target-aware environment text; never assert the controller OS for an SSH target. */
export function getEnvInfo(
  settingsService: ISettingsService,
  executionContext?: ExecutionContext,
  minimal = false,
): string {
  const isRemote = !!executionContext?.isRemote();
  const shellPath = isRemote ? undefined : settingsService.get('app.shellPath') || 'unknown';
  const cwd = executionContext?.getCwd() || process.cwd();
  const osType = isRemote ? undefined : os.type();
  const osRelease = isRemote ? undefined : os.release();
  const osPlatform = isRemote ? undefined : os.platform();
  const now = new Date().toISOString().slice(0, 10);
  const home = isRemote ? '' : `; home (\`~\`): ${os.homedir()}`;
  const hostLine = isRemote
    ? "Host: remote via SSH — OS/shell are the remote machine's, not this controller's, and are unknown here; use commands (e.g. `uname -a`) if you need them"
    : `OS: ${osType} ${osRelease} (${osPlatform}); shell: ${shellPath}`;
  if (minimal) return `${hostLine}; cwd (you're already here, don't \`cd\` to it): ${cwd}${home}; date: ${now}`;
  const topLevel = !executionContext?.isRemote() ? `${getProjectTreeForPrompt(cwd)}` : '';
  return `${hostLine}; cwd (you're already here, don't \`cd\` to it): ${cwd}${home}; date: ${now}\n${topLevel}\n\n`;
}

/** Global instructions precede workspace instructions; unreadable global text is optional. */
export function getAgentsInstructions(cwd: string): string {
  const globalAgentsPath = path.join(os.homedir(), '.agents', 'AGENTS.md');
  const agentsPath = path.join(cwd, 'AGENTS.md');
  const parts: string[] = [];
  try {
    if (fs.existsSync(globalAgentsPath)) {
      const globalContents = fs.readFileSync(globalAgentsPath, 'utf-8').trim();
      if (globalContents) parts.push(`\n\nGlobal AGENTS.md contents (~/.agents/AGENTS.md):\n${globalContents}`);
    }
  } catch {
    // A missing global file must not hide the workspace's instructions.
  }
  if (fs.existsSync(agentsPath)) {
    try {
      const contents = fs.readFileSync(agentsPath, 'utf-8').trim();
      parts.push(`\n\nAGENTS.md contents:\n${contents}`);
    } catch (e: any) {
      parts.push(`\n\nFailed to read AGENTS.md: ${e.message}`);
    }
  }
  return parts.join('');
}
