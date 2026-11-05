import { posix } from 'node:path';
import { quoteShellArg } from '../tools/ssh-service.js';
import type { DirectRemoteWorkspace } from './remote.js';

export type DirectRemoteProjectContext = {
  readonly environment: string;
  readonly instructions: string;
  readonly instructionsPath: string;
  readonly instructionsFound: boolean;
};

/**
 * Load project instructions from the actual SSH workspace, never from a
 * same-spelled local path. Absence is distinct from transport/read failure.
 * The caller appends instructions only when the selected profile enables that
 * context source; it must not substitute a local SkillsService scan for SSH.
 */
export async function loadDirectRemoteProjectContext(
  remote: DirectRemoteWorkspace,
  signal: AbortSignal,
): Promise<DirectRemoteProjectContext> {
  const instructionsPath = posix.join(remote.workspace.root, 'AGENTS.md');
  const service = remote.executionContext.getSSHService();
  if (!remote.executionContext.isRemote() || !service) throw new Error('Direct remote context has no SSH service.');
  return remote.runTool('read_file', signal, async () => {
    const file = quoteShellArg(instructionsPath);
    const result = await service.executeCommand(
      `if [ ! -e ${file} ] && [ ! -L ${file} ]; then exit 3; fi; cat -- ${file}`,
    );
    if (result.exitCode === 3 && !result.timedOut) {
      return { environment: remote.environment, instructions: '', instructionsPath, instructionsFound: false };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Cannot read remote project instructions: ${result.stderr || `exit ${result.exitCode}`}`);
    }
    const content = result.stdout.trim();
    return {
      environment: remote.environment,
      instructions: content
        ? `\n\nRemote AGENTS.md contents (${remote.workspace.target}${instructionsPath}):\n${content}`
        : '',
      instructionsPath,
      instructionsFound: true,
    };
  });
}
