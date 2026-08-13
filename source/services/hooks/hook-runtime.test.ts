import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExecutionContext } from '../execution-context.js';
import type { ISSHService } from '../service-interfaces.js';
import { createRootHookRuntime } from './hook-composition.js';

const testRoot = join(tmpdir(), `term2-hook-runtime-${process.pid}`);

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

it('keeps hook discovery and session metadata local when tools use SSH', async () => {
  const localCwd = join(testRoot, 'local-project');
  const remoteDir = join(testRoot, 'remote-project');
  const eventLog = join(testRoot, 'events.log');
  const executeCommand = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }));
  const sshService: ISSHService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand,
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };
  const remoteExecution = new ExecutionContext(sshService, remoteDir);

  await mkdir(join(localCwd, '.term2', 'hooks'), { recursive: true });
  await mkdir(join(remoteDir, '.term2', 'hooks'), { recursive: true });
  await writeFile(
    join(localCwd, '.term2', 'hooks', '01-local.ts'),
    `import { appendFileSync } from 'node:fs';
export default function register(term2: any) {
  term2.on('session.start', (event: { cwd: string }) => appendFileSync(${JSON.stringify(
    eventLog,
  )}, 'local project:' + event.cwd + '\\n'));
}
`,
  );
  await writeFile(
    join(remoteDir, '.term2', 'hooks', '01-remote.ts'),
    `import { appendFileSync } from 'node:fs';
export default function register() { appendFileSync(${JSON.stringify(eventLog)}, 'remote hook ran\\n'); }
`,
  );

  expect(remoteExecution.getCwd()).toBe(remoteDir);
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(localCwd);
  try {
    const runtime = createRootHookRuntime({
      executionContext: remoteExecution,
      userEnabled: false,
      projectEnabled: true,
      trustedProjectRoots: [localCwd],
    });
    await runtime.hookService.initialize();
    await runtime.hookService.emit({
      type: 'session.start',
      schemaVersion: 1,
      eventId: 'event-1',
      sessionId: 'session-1',
      timestamp: Date.now(),
      scope: 'root',
      cwd: runtime.cwd,
      mode: 'interactive',
      providerName: 'fixture',
      modelName: 'fixture',
    });

    await expect(readFile(eventLog, 'utf8')).resolves.toBe(`local project:${localCwd}\n`);
    expect(executeCommand).not.toHaveBeenCalled();
    await runtime.hookService.shutdown();
  } finally {
    cwd.mockRestore();
  }
});
