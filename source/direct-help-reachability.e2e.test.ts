import { resolveSettingsDirectory } from './services/settings/settings-path.js';
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';

const cli = testCliPath(fileURLToPath(new URL('../rewrite/dist/rewrite/src/app/cli.js', import.meta.url)));

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
      const menu = terminal.getVisibleOutput().slice(menuOffset);
      expect(menu).toContain('╭');
      expect(menu).toContain('Commands');
      expect(menu).toContain('╰');
      expect(menu).toContain('› /help');
      const menuLines = menu.slice(menu.lastIndexOf('╭'), menu.lastIndexOf('╰')).split('\n');
      expect(menuLines.filter((line) => /[› ] \/[a-z-]+\s/.test(line)).length).toBe(Math.min(10, rows - 12));
      // Navigate past the first short-screen window; the selected command must remain visible.
      for (let i = 0; i < 8; i++) {
        terminal.write('\x1b[B');
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await terminal.waitForOutput('› /resume', 30_000);
      terminal.write('help');
      await waitForHarnessComposerValue(idle, '/help', { timeoutMs: 60_000 });
      terminal.write('\r');
      await terminal.waitForOutput('Keyboard shortcuts', 30_000);
      expect(terminal.getVisibleOutput()).toContain('Keyboard shortcuts');
      expect(terminal.getVisibleOutput()).toContain('Ctrl+G approvals/tasks');
      for (let i = 0; i < 12; i++) {
        terminal.write('\x1b[6~');
        await new Promise((r) => setTimeout(r, 80));
      }
      await terminal.waitForOutput('/orchestrator —', 30_000);
      const table = fs.readFileSync(
        fileURLToPath(new URL('../rewrite/src/clients/tui/slash-commands.ts', import.meta.url)),
        'utf8',
      );
      const commands = [...table.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!);
      expect(commands.length).toBeGreaterThan(20);
      for (const command of commands) expect(terminal.getOutput()).toContain(command);
      for (const command of ['/plan', '/mentor', '/bare', '/mcp', '/restart', '/quit']) {
        expect(terminal.getVisibleOutput()).toContain(`${command} —`);
      }
      terminal.write('\x1b[5~');
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      terminal.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}
