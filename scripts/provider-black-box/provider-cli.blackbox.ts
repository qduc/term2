import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import { runIsolatedCli } from './provider-test-harness.js';

let server: FakeProviderHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('assembled provider CLI black-box', () => {
  it('runs the shipped CLI through a runtime provider and captures a complete request', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'success', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
      deadlineMs: 15_000,
      prepare: async (root) => {
        const settingsDir = join(root, 'Library', 'Logs', 'term2-nodejs');
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
          join(settingsDir, 'settings.json'),
          JSON.stringify({
            agent: { model: 'fixture', provider: 'fixture-provider', transport: 'http' },
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
    expect(result.stdout).toContain('hello');
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toContain('chat/completions');
    expect(server.requests[0]?.body).toMatchObject({ model: 'fixture' });
  });

  it('reports provider errors without fabricating successful output', async () => {
    server = await startFakeProviderHttpServer({ scenario: 'error', protocol: 'chat-completions' });
    const result = await runIsolatedCli({
      cwd: process.cwd(),
      args: ['fixture prompt', '--provider', 'fixture-provider', '--model', 'fixture'],
      deadlineMs: 15_000,
      prepare: async (root) => {
        const settingsDir = join(root, 'Library', 'Logs', 'term2-nodejs');
        await mkdir(settingsDir, { recursive: true });
        await writeFile(
          join(settingsDir, 'settings.json'),
          JSON.stringify({
            agent: { model: 'fixture', provider: 'fixture-provider' },
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
