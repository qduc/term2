import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnTerminal, type TerminalSession } from './test-helpers/terminal-e2e.js';

const E2E_TIMEOUT_MS = 45_000;

let session: TerminalSession | null = null;
let tempHome = '';
let tempConversationsDir = '';

afterEach(() => {
  session?.dispose();
  session = null;

  if (tempConversationsDir && fs.existsSync(tempConversationsDir)) {
    fs.rmSync(tempConversationsDir, { recursive: true, force: true });
  }
  tempConversationsDir = '';

  if (tempHome && fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
  tempHome = '';
});

it.sequential('starts the terminal UI and exits on Ctrl+C', { timeout: E2E_TIMEOUT_MS }, async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-home-'));
  tempConversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-conversations-'));

  session = spawnTerminal('node', ['--import', 'tsx', 'source/cli.tsx', '--lite'], {
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: tempConversationsDir,
      DISABLE_LOGGING: '1',
    },
  });

  await session.waitForOutput('Lite', E2E_TIMEOUT_MS);
  await session.waitForOutput('❯ ', E2E_TIMEOUT_MS);

  session.write('\x03');

  const exit = await session.waitForExit(E2E_TIMEOUT_MS);
  expect(exit.exitCode).toBe(0);
  expect(session.getVisibleOutput()).toContain('Lite');
  expect(session.getVisibleOutput()).toContain('❯ ');
});
