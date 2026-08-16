import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import {
  createIsolatedWorkspaceLease,
  writePtyTextAndSubmit,
  type IsolatedWorkspacePaths,
} from './provider-test-harness.js';

let server: FakeProviderHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const BUILT_CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

async function writeFixtureSettings(paths: IsolatedWorkspacePaths, options: { trustedProjectRoots?: string[] } = {}) {
  await mkdir(paths.logDir, { recursive: true });
  await writeFile(
    join(paths.logDir, 'settings.json'),
    JSON.stringify({
      agent: { model: 'fixture', provider: 'fixture-provider', transport: 'http' },
      app: { liteMode: true },
      hooks: {
        user: { enabled: true },
        project: { enabled: true },
        trustedProjectRoots: options.trustedProjectRoots ?? [],
      },
      providers: [
        {
          id: 'fixture-provider',
          name: 'fixture-provider',
          type: 'openai-compatible',
          baseUrl: server?.baseUrl,
          apiKey: 'fixture-key',
        },
      ],
    }),
  );
}

async function writeTypeScriptStatusHook(path: string, label: string, logPath: string) {
  await writeFile(
    path,
    `import { appendFileSync } from 'node:fs';
import type { StatusChangeHookEvent } from '@qduc/term2/hooks';

export default function register(term2: any) {
  term2.on('status.change', (event: StatusChangeHookEvent) => {
    appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(
      label,
    )} + ':' + event.current + ':' + event.type + '\\n');
  });
}
`,
  );
}

describe('public hooks through the packaged CLI', () => {
  it('loads a TypeScript user hook and delivers status.change in non-interactive mode', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const workspace = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        await writeFixtureSettings(paths);
        const hookDir = join(root, '.term2', 'hooks');
        await mkdir(hookDir, { recursive: true });
        await writeTypeScriptStatusHook(join(hookDir, '01-user.ts'), 'user', join(root, 'hook-events.log'));
      },
    });
    try {
      const result = await workspace.runCli({
        cwd: process.cwd(),
        args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
        deadlineMs: 15_000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      await expect(readFile(join(workspace.root, 'hook-events.log'), 'utf8')).resolves.toContain(
        'user:working:status.change',
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('loads a TypeScript user hook and delivers status.change in interactive mode', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const workspace = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        await writeFixtureSettings(paths);
        const hookDir = join(root, '.term2', 'hooks');
        await mkdir(hookDir, { recursive: true });
        await writeTypeScriptStatusHook(join(hookDir, '01-user.ts'), 'user', join(root, 'hook-events.log'));
      },
    });
    try {
      const child = await workspace.start({
        args: ['--lite', '--provider', 'fixture-provider', '--model', 'fixture'],
        cwd: process.cwd(),
        cols: 120,
        rows: 40,
      });
      await child.waitForIdleInput({ timeoutMs: 15_000 });
      await writePtyTextAndSubmit(child, 'fixture prompt');
      await child.waitForVisibleOutput('hello', 15_000);
      await writePtyTextAndSubmit(child, '/quit');
      await child.waitForExit(15_000);

      await expect(readFile(join(workspace.root, 'hook-events.log'), 'utf8')).resolves.toContain(
        'user:working:status.change',
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it('runs TypeScript user hooks before trusted project hooks in deterministic order', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    let projectDir = '';
    const workspace = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        projectDir = join(root, 'project');
        const eventLog = join(root, 'hook-events.log');
        await mkdir(join(root, '.term2', 'hooks'), { recursive: true });
        await mkdir(join(projectDir, '.term2', 'hooks'), { recursive: true });
        await writeFixtureSettings(paths, { trustedProjectRoots: [projectDir] });
        await writeTypeScriptStatusHook(join(root, '.term2', 'hooks', '01-user.ts'), 'user', eventLog);
        await writeTypeScriptStatusHook(join(projectDir, '.term2', 'hooks', '01-project.ts'), 'project', eventLog);
      },
    });
    try {
      const result = await workspace.runCli({
        cwd: projectDir,
        cliPath: BUILT_CLI,
        args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
        deadlineMs: 15_000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      const events = (await readFile(join(workspace.root, 'hook-events.log'), 'utf8'))
        .trim()
        .split('\n')
        .filter((line) => line.endsWith(':working:status.change'));
      expect(events).toEqual(['user:working:status.change', 'project:working:status.change']);
    } finally {
      await workspace.cleanup();
    }
  });
});
