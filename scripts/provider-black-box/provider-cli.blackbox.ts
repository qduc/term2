import { mkdir, writeFile } from 'node:fs/promises';
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
  it('runs a bounded handoff through the real supervisor, private pipe, and built CLI', async () => {
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
