import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnTerminal, type TerminalSession } from './test-helpers/terminal-e2e.js';
import { HARNESS_IDLE_ENV, waitForHarnessIdleGeneration } from './lib/harness-input-idle.js';

// tsx cold-starts the whole app through an on-demand transform; inside CI's
// full-suite run that competes with dozens of vitest workers for every core,
// so first paint can take minutes rather than seconds. The budget is large
// on purpose; a real failure now dumps the child's visible output instead of
// failing blind.
const STARTUP_TIMEOUT_MS = 240_000;
const EXIT_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 600_000;

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

it.sequential('starts the terminal UI and exits on Ctrl+C', { timeout: TEST_TIMEOUT_MS }, async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-home-'));
  tempConversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-conversations-'));

  const idlePath = path.join(tempHome, 'input-idle');
  session = spawnTerminal('node', ['--import', 'tsx', 'source/cli.tsx', '--lite'], {
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      OPENAI_API_KEY: 'test-key',
      TERM2_CONVERSATIONS_DIR: tempConversationsDir,
      DISABLE_LOGGING: '1',
      [HARNESS_IDLE_ENV]: idlePath,
    },
  });

  // The banner's mode pill renders "LITE" (Banner.tsx); do not wait on
  // StatusBar text below the fold, which is not part of the first paint.
  await session.waitForOutput('LITE', STARTUP_TIMEOUT_MS);
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: STARTUP_TIMEOUT_MS });

  session.write('\x03');

  const exit = await session.waitForExit(EXIT_TIMEOUT_MS);
  expect(exit.exitCode).toBe(0);
  expect(session.getVisibleOutput()).toContain('Lite');
});
