import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnTerminal } from './test-helpers/terminal-e2e.js';
import { HARNESS_IDLE_ENV, waitForHarnessIdleGeneration } from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

// Drive the actual first-run wizard and its menu/editor boundary, not mocked
// hooks. Every child starts under env -i and can discover only our loopback URL.
it.each(['unreachable', 'catalog'] as const)(
  'finishes fresh Ollama setup with %s model discovery',
  { timeout: 120_000 },
  async (discovery) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-first-run-'));
    const requests: string[] = [];
    const fixture = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }));
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture port');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    if (discovery === 'unreachable') await new Promise<void>((resolve) => fixture.close(() => resolve()));
    const stateDir = path.join(home, 'state');
    const idlePath = path.join(home, 'input-idle');
    const session = spawnTerminal(
      'env',
      [
        '-i',
        `PATH=${process.env.PATH}`,
        `HOME=${home}`,
        `XDG_CONFIG_HOME=${home}/config`,
        `XDG_CACHE_HOME=${home}/cache`,
        `XDG_DATA_HOME=${home}/data`,
        `XDG_STATE_HOME=${stateDir}`,
        `TERM2_CONVERSATIONS_DIR=${home}/conversations`,
        `${HARNESS_IDLE_ENV}=${idlePath}`,
        'TERM=xterm-256color',
        'CI=false',
        'node',
        '--import',
        'tsx',
        'source/cli.tsx',
      ],
      { cols: 120, rows: 40 },
    );
    // Separate terminal events: batching arrow+Enter can legitimately deliver
    // both against a pre-render selection. Wait for each observed transition.
    const press = async (key: string) => {
      session.write(key);
      await new Promise((resolve) => setTimeout(resolve, 150));
    };
    const settingsPath = path.join(
      resolveSettingsDirectory({ homeDir: home, env: { XDG_STATE_HOME: stateDir } }),
      'settings.json',
    );
    const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    try {
      await session.waitForOutput('Your Providers', 60_000);
      await press('\r');
      await session.waitForOutput('Alibaba / Qwen');
      await press('ollama');
      await session.waitForOutput('Ollama (local)');
      await press('\r');
      await session.waitForOutput('Review & Save Provider');
      // Template starts on API Key. Point Base URL at the isolated fixture.
      await press('\x1b[A');
      await press('\r');
      await session.waitForOutput('Step 3: Base URL');
      for (let i = 0; i < 'http://127.0.0.1:11434/v1'.length; i++) await press('\x7f');
      await press(baseUrl);
      await press('\r');
      await press('\x1b[B');
      await press('\x1b[B');
      await press('\r');
      await expect
        .poll(() => readSettings().providers?.find((provider: { id: string }) => provider.id === 'ollama')?.baseUrl)
        .toBe(baseUrl);
      const modelStepOffset = session.getVisibleOutput().length;
      await press('\r');
      // This was a banner with no picker on the broken implementation.
      await session.waitForOutput('Choose a model to finish setup', 10_000);
      await expect
        .poll(() => session.getVisibleOutput().slice(modelStepOffset), { timeout: 10_000 })
        .toContain('Filter:');
      if (discovery === 'unreachable') {
        await session.waitForOutput('Some providers failed: ollama');
        // Escape must not leave setup stranded without an input surface.
        const offset = session.getVisibleOutput().length;
        await press('\x1b');
        await expect.poll(() => session.getVisibleOutput().slice(offset)).toContain('Filter:');
        await press('dummy-model');
      } else {
        await session.waitForOutput('fixture-model');
        expect(requests).toContain('/v1/models');
        await press('fixture-model');
      }
      await press('\r');
      const model = discovery === 'unreachable' ? 'dummy-model' : 'fixture-model';
      await expect.poll(() => readSettings().agent.modelSelection).toEqual({ provider: 'ollama', model });
      await session.waitForOutput(`ollama/${model}`);
      await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 15_000 });
      // A second menu round trip proves setup ended and ordinary commands work.
      await press('/model ');
      await press('\x1b');
      await press('\x03');
      await session.waitForOutput('Press Ctrl+C again to exit');
      await press('\x03');
      expect((await session.waitForExit(15_000)).exitCode).toBe(0);
      expect(requests.every((url) => url === '/v1/models')).toBe(true);
    } catch (error) {
      throw new Error(`${String(error)}\nTerminal output:\n${session.getVisibleOutput().slice(-5000)}`);
    } finally {
      session.dispose();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
