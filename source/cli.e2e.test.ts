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

it.sequential.each(['lite', 'bare'])(
  'starts the %s terminal UI and exits on the second Ctrl+C',
  { timeout: TEST_TIMEOUT_MS },
  async (profile) => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-home-'));
    tempConversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-conversations-'));

    const idlePath = path.join(tempHome, 'input-idle');
    session = spawnTerminal(
      'node',
      ['--import', 'tsx', 'source/cli.tsx', ...(profile === 'lite' ? ['--lite'] : ['--profile', 'bare'])],
      {
        cwd: process.cwd(),
        env: {
          HOME: tempHome,
          OPENAI_API_KEY: 'test-key',
          TERM2_CONVERSATIONS_DIR: tempConversationsDir,
          DISABLE_LOGGING: '1',
          [HARNESS_IDLE_ENV]: idlePath,
          // Ink suppresses dynamic terminal updates in CI mode; this test needs an interactive TUI.
          CI: 'false',
        },
      },
    );

    // Idle is application-owned evidence that startup reached the composer.
    // Bare's identity is checked in the session header below, independently
    // of the banner's legacy presentation labels.
    if (profile === 'lite') await session.waitForOutput('LITE', STARTUP_TIMEOUT_MS);
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: STARTUP_TIMEOUT_MS });

    if (profile === 'bare') {
      const headers = fs
        .readdirSync(tempConversationsDir, { recursive: true })
        .filter((file) => String(file).endsWith('.jsonl'))
        .flatMap((file) =>
          fs
            .readFileSync(path.join(tempConversationsDir, String(file)), 'utf8')
            .trim()
            .split('\n'),
        )
        .map((line) => JSON.parse(line).event)
        .filter((event) => event?.type === 'session_init');
      expect(headers).toHaveLength(1);
      expect(headers[0]).toMatchObject({
        activeProfileId: 'builtin:bare',
        activeProfileVersion: '1.3.0',
        appMode: { orchestratorMode: false, liteMode: false, planMode: false, mentorMode: false },
      });
      expect(headers[0].activeProfileDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', EXIT_TIMEOUT_MS);
    session.write('\x03');

    const exit = await session.waitForExit(EXIT_TIMEOUT_MS);
    expect(exit.exitCode).toBe(0);
    if (profile === 'lite') expect(session.getVisibleOutput()).toContain('Lite');
    expect(session.getVisibleOutput()).not.toContain('Session:');
    expect(session.getVisibleOutput()).not.toContain('To resume this conversation:');
  },
);
