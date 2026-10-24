import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import { runIsolatedCli, createIsolatedWorkspaceLease } from './provider-test-harness.js';

let server: FakeProviderHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('assembled provider CLI black-box', () => {
  it('resumes headlessly with persisted history and appends to the same conversation', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const workspace = await createIsolatedWorkspaceLease({
      prepare: async (_root, paths) => {
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' } },
            app: { liteMode: true },
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
      },
    });
    try {
      const first = await workspace.runCli({
        cwd: process.cwd(),
        args: ['Remember amber tortoise', '--reasoning', 'high', '--json'],
        deadlineMs: 15000,
      });
      expect(first.exitCode, first.stderr).toBe(0);
      const dir = workspace.paths.conversationsDir;
      const logs = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
      expect(logs).toHaveLength(1);
      const id = logs[0]!.slice(0, -6);
      const before = await readFile(join(dir, logs[0]!), 'utf8');
      const resumed = await workspace.runCli({
        cwd: process.cwd(),
        args: ['--resume', id, 'Recall the animal', '--json'],
        deadlineMs: 15000,
      });
      expect(resumed.exitCode, resumed.stderr).toBe(0);
      const wire = JSON.stringify(server.requests.at(-1)?.body);
      expect(wire).toContain('Remember amber tortoise');
      expect(wire).toContain('Recall the animal');
      const after = await readFile(join(dir, logs[0]!), 'utf8');
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain('Recall the animal');
      const latestInit = (text: string) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((envelope) => envelope.event.type === 'session_init')
          .at(-1).event;
      expect(latestInit(after).reasoningEffort).toBe('high');
      expect((await readdir(dir)).filter((name) => name.endsWith('.jsonl'))).toEqual(logs);
      for (const line of resumed.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
      const forked = await workspace.runCli({
        cwd: process.cwd(),
        args: ['--resume', id, '--fork', 'Fork follow-up', '--json'],
        deadlineMs: 15000,
      });
      expect(forked.exitCode, forked.stderr).toBe(0);
      expect(JSON.stringify(server.requests.at(-1)?.body)).toContain('Recall the animal');
      expect(await readFile(join(dir, logs[0]!), 'utf8')).toBe(after);
      const forkLogs = (await readdir(dir)).filter((name) => name.endsWith('.jsonl') && name !== logs[0]);
      expect(forkLogs).toHaveLength(1);
      const forkInit = latestInit(await readFile(join(dir, forkLogs[0]!), 'utf8'));
      expect(forkInit.forkedFrom).toBe(id);
      expect(forkInit.reasoningEffort).toBe('high');
      for (const line of forked.stdout.trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
      const requestCount = server.requests.length;
      const missing = await workspace.runCli({
        cwd: process.cwd(),
        args: ['--resume', 'missing-session', 'follow-up'],
        deadlineMs: 15000,
      });
      expect(missing.exitCode).toBe(1);
      expect(missing.stderr).toContain('No conversation found to resume');
      expect(server.requests).toHaveLength(requestCount);
    } finally {
      await workspace.cleanup();
    }
  });

  // The supervisor deliberately fails closed without Linux /proc ownership proof.
  it('enforces platform ownership support through the real supervisor, private pipe, and built CLI', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const workspace = await createIsolatedWorkspaceLease({
      prepare: async (root, paths) => {
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(join(root, 'handoff.txt'), 'fixture private handoff');
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, maxOutputTokens: 32000 },
            app: { liteMode: true },
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
      },
    });
    try {
      const result = await workspace.runCli({
        cwd: process.cwd(),
        cwd: process.cwd(),
        cliPath: join(process.cwd(), 'tools/supervised-term2/launch.mjs'),
        args: [
          '--prompt',
          join(workspace.root, 'handoff.txt'),
          '--lock',
          join(workspace.root, 'worker.lock'),
          '--',
          '--provider',
          'fixture-provider',
          '--model',
          'fixture',
        ],
        deadlineMs: 15000,
      });
      expect(result.timedOut).toBe(false);
      if (process.platform !== 'linux') {
        expect(result.exitCode, result.stderr).toBe(1);
        expect(result.stderr).toContain('unsupported_platform');
        expect(server.requests).toHaveLength(0);
        return;
      }
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toBe('hello\n');
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]?.body).toMatchObject({ max_tokens: 8192 });
      expect(JSON.stringify(server.requests[0]?.body)).toContain('fixture private handoff');
    } finally {
      await workspace.cleanup();
    }
  });
  it('rejects excessive input before the shipped CLI makes any provider request', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['x'.repeat(100000), '--provider', 'fixture-provider', '--model', 'fixture'],
      deadlineMs: 15000,
      prepare: async (_root, paths) => {
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, maxRequestInputTokens: 1000 },
            app: { liteMode: true },
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
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('configured ceiling');
    expect(server.requests).toHaveLength(0);
  });

  it('applies the supervised output profile on the actual wire while allowing useful work', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
      env: { TERM2_SUPERVISED: '1' },
      deadlineMs: 15000,
      prepare: async (_root, paths) => {
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            agent: {
              modelSelection: { model: 'fixture', provider: 'fixture-provider' },
              maxOutputTokens: 32000,
              contextCompaction: { enabled: false },
            },
            app: { liteMode: true },
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
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body).toMatchObject({ max_tokens: 8192 });
  });
  it('runs the shipped CLI through a runtime provider and captures a complete request', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
      deadlineMs: 15_000,
      prepare: async (_root, paths) => {
        const settingsDir = paths.logDir;
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
          join(settingsDir, 'settings.json'),
          JSON.stringify({
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, transport: 'http' },
            app: { liteMode: true },
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
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toContain('chat/completions');
    expect(server.requests[0]?.body).toMatchObject({ model: 'fixture' });
  });

  it('prints terminal-only response text exactly once', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'final-only', protocol: 'responses' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'openai', '--model', 'fixture'],
      env: { OPENAI_BASE_URL: `${server.baseUrl}/v1` },
      deadlineMs: 15_000,
      prepare: async (_root, paths) => {
        const settingsDir = paths.logDir;
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
          join(settingsDir, 'settings.json'),
          JSON.stringify({
            agent: {
              modelSelection: { model: 'fixture', provider: 'openai' },
              transport: 'http',
              openai: { apiKey: 'fixture-key' },
            },
            app: { liteMode: true },
          }),
        );
      },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.stdout.match(/hello/g)).toHaveLength(1);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe('/v1/responses');
  });

  it('reports provider errors without fabricating successful output', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'error', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
      deadlineMs: 15_000,
      prepare: async (_root, paths) => {
        const settingsDir = paths.logDir;
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
          join(settingsDir, 'settings.json'),
          JSON.stringify({
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' } },
            app: { liteMode: true },
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
      },
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('hello');
  });
});
