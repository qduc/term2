import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { writeMockCliSettings } from '../helpers/mock-cli-settings.js';
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testCliPath, spawnTerminal, type TerminalSession } from '../helpers/terminal-e2e.js';
import { HARNESS_IDLE_ENV, waitForHarnessIdleGeneration } from '../../src/shared/lib/harness-input-idle.js';

// The built entry is plain JavaScript: launch it with node alone. Loading it through
// `--import tsx` transformed the 17 MB bundle on every start (about 3.5 s each).
// The budgets only bound a real hang; a failure dumps the child's visible output.
const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 180_000;

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

it.sequential.each([
  { profile: 'lite', skin: 'classic' },
  ...['classic', 'cards', 'rail', 'ledger', 'zen'].map((skin) => ({ profile: 'bare', skin })),
])(
  'starts the $profile terminal UI with $skin skin and no profile labels',
  { timeout: TEST_TIMEOUT_MS },
  async ({ profile, skin }) => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-home-'));
    tempConversationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-e2e-conversations-'));

    writeMockCliSettings(tempHome);
    const settingsFile = path.join(resolveSettingsDirectory({ homeDir: tempHome }), 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.ui = { skin };
    fs.writeFileSync(settingsFile, JSON.stringify(settings));
    const idlePath = path.join(tempHome, 'input-idle');
    session = spawnTerminal(
      'node',
      [testCliPath('dist/cli.js'), ...(profile === 'lite' ? ['--lite'] : ['--profile', 'bare'])],
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
    // --lite is an alias of Bare, so both start the same Profile; the identity
    // is checked in the session header below.
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: STARTUP_TIMEOUT_MS });
    expect(session.getVisibleOutput()).not.toMatch(/Profile:|\bBARE\b|\bBare\b/);
    expect(session.getVisibleOutput()).toContain('mock-alpha');

    {
      const headers = fs
        .readdirSync(tempConversationsDir, { recursive: true })
        .filter((file) => String(file).endsWith('.jsonl'))
        .flatMap((file) =>
          fs
            .readFileSync(path.join(tempConversationsDir, String(file)), 'utf8')
            .trim()
            .split('\n'),
        )
        .map((line) => JSON.parse(line))
        // term2-next keeps its own store: `{v:2, fact}` rows with a session_started header.
        .map((row) =>
          row.fact?.type === 'session_started'
            ? {
                type: 'session_init',
                activeProfileId: row.fact.profile.id,
                activeProfileVersion: row.fact.profile.version,
                activeProfileDigest: row.fact.profile.digest,
              }
            : row.event,
        )
        .filter((event) => event?.type === 'session_init');
      expect(headers).toHaveLength(1);
      expect(headers[0]).toMatchObject({
        activeProfileId: 'builtin:bare',
        activeProfileVersion: '2.0.0',
      });
      expect(headers[0].activeProfileDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', EXIT_TIMEOUT_MS);
    session.write('\x03');

    const exit = await session.waitForExit(EXIT_TIMEOUT_MS);
    expect(exit.exitCode).toBe(0);
    expect(session.getVisibleOutput()).not.toContain('Session:');
    expect(session.getVisibleOutput()).not.toContain('To resume this conversation:');
  },
);
