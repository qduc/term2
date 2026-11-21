import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
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
} from '../../src/shared/lib/harness-input-idle.js';

const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));

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
      const finishedBox = () => {
        const fresh = terminal.getVisibleOutput().slice(menuOffset);
        return fresh.lastIndexOf('╰') > fresh.lastIndexOf('╭');
      };
      await expect.poll(finishedBox, { timeout: 30_000 }).toBe(true);
      const menu = terminal.getVisibleOutput().slice(menuOffset);
      expect(menu).toContain('╭');
      expect(menu).toContain('Commands');
      expect(menu).toContain('╰');
      expect(menu).toContain('Setup');
      expect(menu).toContain('Conversation');
      expect(menu).toContain('❯ /model');
      // Navigate past the first window; the selected command must remain visible.
      for (const name of [
        'effort',
        'providers',
        'settings',
        'auto-approve',
        'skills',
        'clear',
        'resume',
        'goal',
        'copy',
        'usage',
        'compact',
        'handoff',
        'rewind',
        'retry',
      ]) {
        terminal.write('\x1b[B');
        await terminal.waitForOutput(`❯ /${name}`, 30_000);
      }
      await terminal.waitForOutput('Rewind & Retry', 30_000);
      const retryOffset = terminal.getVisibleOutput().length;
      terminal.write('retry');
      await waitForHarnessComposerValue(idle, '/retry', { timeoutMs: 60_000 });
      const retryMenu = () => terminal.getVisibleOutput().slice(retryOffset);
      await expect.poll(retryMenu, { timeout: 30_000 }).toMatch(/Command: \/retry[\s\S]*❯ \/retry +Resend[\s\S]*╰/);
      expect(retryMenu()).not.toMatch(/\/retry-(?:tool|turn)/);
      terminal.write('\x1b');
      await waitForHarnessComposerValue(idle, '', { timeoutMs: 60_000 });
      terminal.write('/help');
      await waitForHarnessComposerValue(idle, '/help', { timeoutMs: 60_000 });
      terminal.write('\r');
      // Help must be emitted in full without keyboard paging, even on a short terminal.
      await terminal.waitForOutput('@: complete paths · !: shell', 30_000);
      const helpOutput = terminal.getVisibleOutput();
      expect(helpOutput).not.toMatch(/Profile:|\bBARE\b/);
      expect(helpOutput).toMatch(/Application\r?\n +\/help —/);
      expect(helpOutput).toContain('/retry tool continues from the last tool result');
      expect(helpOutput).toContain('/settings reset <key>');
      expect(helpOutput.lastIndexOf('Keyboard shortcuts')).toBeGreaterThan(helpOutput.lastIndexOf('/help —'));
      // Every browsable command should appear in help.
      const table = fs.readFileSync(
        fileURLToPath(new URL('../../src/clients/tui/menus/legacy-commands.ts', import.meta.url)),
        'utf8',
      );
      const commands = [...table.matchAll(/name: '([^']+)'/g)].map((match) => match[1]!);
      expect(commands.length).toBeGreaterThan(20);
      for (const command of commands.filter((name) => !['undo', 'retry-turn', 'retry-tool'].includes(name))) {
        expect(helpOutput).toContain(`/${command} —`);
      }
      expect(helpOutput).not.toMatch(/\/(?:undo|retry-tool|retry-turn) —/);
      // Dropped by owner scope, or never in legacy.
      for (const command of [
        '/profile',
        '/bare',
        '/lite',
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
      if (cols === 60) {
        for (const [command, notice] of [
          ['/ReTrY  TOOL', 'No tool call to retry.'],
          ['/retry-tool', 'No tool call to retry.'],
          ['/retry tool extra', 'Unrecognised argument "tool"'],
          ['/retr last', 'Ambiguous command /retr'],
        ] as const) {
          const offset = terminal.getVisibleOutput().length;
          terminal.write(command);
          await waitForHarnessComposerValue(idle, command, { timeoutMs: 60_000 });
          terminal.write('\r');
          await expect.poll(() => terminal.getVisibleOutput().slice(offset), { timeout: 30_000 }).toContain(notice);
        }
      }
    } finally {
      terminal.dispose();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 120_000);
}
