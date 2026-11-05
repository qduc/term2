import { resolveSettingsDirectory } from '../../rewrite/src/config/settings/settings-path.js';
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../rewrite/src/shared/lib/harness-input-idle.js';

const cli = testCliPath(fileURLToPath(new URL('../dist/rewrite/src/app/cli.js', import.meta.url)));

for (const [cols, rows] of [
  [119, 40],
  [60, 18],
]) {
  it(`shows the beginning and end of help at ${cols}x${rows}`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-help-'));
    const idle = path.join(root, 'idle');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const settingsDir = resolveSettingsDirectory({
      homeDir: root,
      env: createTestChildEnv({ HOME: root, XDG_STATE_HOME: path.join(root, 'state') }),
    });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [
          { name: 'mockprov', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-key' },
        ],
      }),
    );
    const terminal = spawnTerminal('node', [cli], {
      cols,
      rows,
      cwd: workspace,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_STATE_HOME: path.join(root, 'state'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
        DISABLE_LOGGING: '1',
        CI: 'false',
        [HARNESS_IDLE_ENV]: idle,
      },
    });
    try {
      await terminal.waitForOutput('term²', 10_000);
      await waitForHarnessIdleGeneration(idle, { timeoutMs: 60_000 });
      // Open the broad menu at this terminal size and inspect only its fresh render.
      const menuOffset = terminal.getVisibleOutput().length;
      terminal.write('/');
      await waitForHarnessComposerValue(idle, '/', { timeoutMs: 60_000 });
      await terminal.waitForOutput('Commands', 30_000);
      // The title can arrive in a frame before the box's bottom border; slice only the finished box.
      const boxDeadline = Date.now() + 30_000;
      const finishedBox = () => {
        const fresh = terminal.getVisibleOutput().slice(menuOffset);
        return fresh.lastIndexOf('╰') > fresh.lastIndexOf('╭');
      };
      while (!finishedBox() && Date.now() < boxDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      const menu = terminal.getVisibleOutput().slice(menuOffset);
      expect(menu).toContain('╭');
      expect(menu).toContain('Commands');
      expect(menu).toContain('╰');
      // Legacy's slash menu (ported): first entry selected, a fixed ten-row window.
      expect(menu).toContain('❯ /model');
      // Navigate past the first window; the selected command must remain visible.
      for (let i = 0; i < 10; i++) {
        terminal.write('\x1b[B');
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await terminal.waitForOutput('❯ /retry-tool', 30_000);
      terminal.write('help');
      await waitForHarnessComposerValue(idle, '/help', { timeoutMs: 60_000 });
      terminal.write('\r');
      // Help must be emitted in full without keyboard paging, even on a short terminal.
      // The last help line (legacy's begins `Shift+Tab: switch Standard/Plan · `, dropped with Plan: #149).
      await terminal.waitForOutput('@: complete paths · !: shell', 30_000);
      const helpOutput = terminal.getOutput();
      expect(helpOutput.lastIndexOf('Keyboard shortcuts')).toBeGreaterThan(helpOutput.lastIndexOf('/help —'));
      // Legacy's command table, except /undo, as the slash menu lists it.
      const table = fs.readFileSync(
        fileURLToPath(new URL('../../rewrite/src/clients/tui/menus/legacy-commands.ts', import.meta.url)),
        'utf8',
      );
      const commands = [...table.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!);
      expect(commands.length).toBeGreaterThan(20);
      for (const command of commands.filter((name) => name !== 'undo')) expect(helpOutput).toContain(`/${command} —`);
      // Dropped by owner scope, or never in legacy.
      for (const command of [
        '/plan',
        '/mentor',
        '/orchestrator',
        '/sandbox',
        '/mcp',
        '/tasks',
        '/queue',
        '/answer',
        '/cancel',
        '/rollover',
        '/command-status',
        '/command-apply',
      ]) {
        expect(helpOutput).not.toContain(`${command} —`);
      }
      expect(terminal.getVisibleOutput()).not.toMatch(/Lines 1[–-]\d+ of \d+/);
    } finally {
      terminal.dispose();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);
}
