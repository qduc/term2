import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawnTerminal } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
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
    const settingsPath = path.join(
      resolveSettingsDirectory({ homeDir: home, env: { XDG_STATE_HOME: stateDir } }),
      'settings.json',
    );
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
    const waitForOutputAfter = async (offset: number, check: (output: string) => boolean, description: string) => {
      try {
        await expect
          .poll(() => check(session.getVisibleOutput().slice(offset)), { interval: 10, timeout: 5_000 })
          .toBe(true);
      } catch (error) {
        throw new Error(`Timed out waiting for ${description}: ${String(error)}`);
      }
    };
    const press = async (key: string, expected: string) => {
      const offset = session.getVisibleOutput().length;
      session.write(key);
      await waitForOutputAfter(offset, (output) => output.includes(expected), expected);
    };
    const pressUntil = async (key: string, check: (output: string) => boolean, description: string) => {
      const offset = session.getVisibleOutput().length;
      session.write(key);
      await waitForOutputAfter(offset, check, description);
    };
    const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    try {
      await session.waitForOutput('Your Providers', 60_000);
      await press('\r', 'Alibaba / Qwen');
      await session.waitForOutput('Alibaba / Qwen');
      await press('ollama', 'ollama');
      await session.waitForOutput('Ollama (local)');
      await press('\r', 'Review & Save Provider');
      await session.waitForOutput('Review & Save Provider');
      // Template starts on API Key. Point Base URL at the isolated fixture.
      await pressUntil('\x1b[A', (output) => /❯\s*Base URL/.test(output), 'Base URL selection');
      await press('\r', 'Step 3: Base URL');
      await session.waitForOutput('Step 3: Base URL');
      const baseUrlOffset = session.getVisibleOutput().length;
      session.write('\x7f'.repeat('http://127.0.0.1:11434/v1'.length) + baseUrl);
      await waitForOutputAfter(baseUrlOffset, (output) => output.includes(baseUrl), 'fixture Base URL input');
      const editorOffset = session.getVisibleOutput().length;
      session.write('\r');
      await waitForOutputAfter(
        editorOffset,
        (output) => output.includes('Save Changes') && output.includes(baseUrl),
        'provider review after Base URL edit',
      );
      await pressUntil('\x1b[B', (output) => /❯\s*API Key/.test(output), 'API Key selection');
      await pressUntil('\x1b[B', (output) => /❯\s*Save Changes/.test(output), 'Save Changes selection');
      session.write('\r');
      await expect
        .poll(() =>
          fs.existsSync(settingsPath)
            ? readSettings().providers?.find((provider: { id: string }) => provider.id === 'ollama')?.baseUrl
            : undefined,
        )
        .toBe(baseUrl);
      const modelStepOffset = session.getVisibleOutput().length;
      await press('\r', 'Choose a model to finish setup');
      // This was a banner with no picker on the broken implementation.
      await session.waitForOutput('Choose a model to finish setup', 10_000);
      await expect
        .poll(() => session.getVisibleOutput().slice(modelStepOffset), { timeout: 10_000 })
        .toContain('Filter:');
      if (discovery === 'unreachable') {
        await session.waitForOutput('Some providers failed: ollama');
        // Escape must not leave setup stranded without an input surface.
        const offset = session.getVisibleOutput().length;
        session.write('\x1b');
        await waitForOutputAfter(offset, (output) => output.includes('Filter:'), 'model filter after Escape');
        await press('dummy-model', 'dummy-model');
      } else {
        await session.waitForOutput('fixture-model');
        expect(requests).toContain('/v1/models');
        await press('fixture-model', 'Filter: fixture-model');
      }
      session.write('\r');
      const model = discovery === 'unreachable' ? 'dummy-model' : 'fixture-model';
      await expect.poll(() => readSettings().agent.modelSelection).toEqual({ provider: 'ollama', model });
      await session.waitForOutput(`ollama/${model}`);
      let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 15_000 });
      // A second menu round trip proves setup ended and ordinary commands work.
      session.write('/model ');
      await waitForHarnessComposerValue(idlePath, '/model ');
      session.write('\x1b');
      idle = await waitForHarnessIdleGeneration(idlePath, { after: idle });
      await press('\x03', 'Press Ctrl+C again to exit');
      await session.waitForOutput('Press Ctrl+C again to exit');
      session.write('\x03');
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
