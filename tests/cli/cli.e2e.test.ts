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

/**
 * What each skin's own files say sets it apart (src/clients/tui/presentation/skins/<name>/index.ts), read from the
 * idle screen: how the banner, the composer, the hints and the status line are drawn. Classic is the base look and
 * the others override slots of it. A layout record is small on purpose: each skin must differ from every other in
 * at least two fields, so swapping two skins, or losing a skin's frame, changes a record.
 *
 *   classic  banner behind a `▌` bar; one hairline above the composer; hints separated by `│`
 *   rail     "the prompt sits between two hairlines, the status is one line": banner on one line, hairlines above
 *            and below the composer, the status right under the hints
 *   cards    "the banner ... the input ... are rounded boxes"
 *   ledger   "a header bar ... a footer bar of chips": banner on one line, chips instead of `│` or `·` separators
 *   zen      "a borderless prompt, a status line you only notice when it has something to say": `›` prompt, no
 *            hairlines, status flush right
 */
type Layout = {
  glyph: string;
  banner: 'bar' | 'box' | 'one-line' | 'two-line';
  ruleAbove: boolean;
  ruleBelow: boolean;
  boxedComposer: boolean;
  hintSeparator: '│' | '·' | 'space';
  blankBeforeStatus: boolean;
  statusAlign: 'left' | 'right';
};

const LAYOUTS: Record<string, Layout> = {
  classic: {
    glyph: '❯',
    banner: 'bar',
    ruleAbove: true,
    ruleBelow: false,
    boxedComposer: false,
    hintSeparator: '│',
    blankBeforeStatus: true,
    statusAlign: 'left',
  },
  rail: {
    glyph: '❯',
    banner: 'one-line',
    ruleAbove: true,
    ruleBelow: true,
    boxedComposer: false,
    hintSeparator: '·',
    blankBeforeStatus: false,
    statusAlign: 'left',
  },
  cards: {
    glyph: '❯',
    banner: 'box',
    ruleAbove: false,
    ruleBelow: false,
    boxedComposer: true,
    hintSeparator: '·',
    blankBeforeStatus: true,
    statusAlign: 'left',
  },
  ledger: {
    glyph: '❯',
    banner: 'one-line',
    ruleAbove: true,
    ruleBelow: false,
    boxedComposer: false,
    hintSeparator: 'space',
    blankBeforeStatus: true,
    statusAlign: 'left',
  },
  zen: {
    glyph: '›',
    banner: 'two-line',
    ruleAbove: false,
    ruleBelow: false,
    boxedComposer: false,
    hintSeparator: '·',
    blankBeforeStatus: true,
    statusAlign: 'right',
  },
};

/** Reads the idle screen's layout from the visible output; undefined while the last frame is incomplete. */
function layoutOf(visibleOutput: string): Layout | undefined {
  const lines = visibleOutput.split(/\r?\n/).map((line) => line.trimEnd());
  const isRule = (line: string | undefined) => /^\s*─{20,}$/.test(line ?? '');
  const lastIndexWhere = (matches: (line: string) => boolean) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) if (matches(lines[index]!)) return index;
    return -1;
  };
  const composer = lastIndexWhere((line) => /^\s*(│\s*)?[❯›](\s|$)/.test(line));
  const banner = lines.find((line) => line.trim() !== '' && /term²|[▌╭]/.test(line));
  const hints = lines.findIndex((line, index) => index > composer && composer >= 0 && line.includes('/ commands'));
  const status = lastIndexWhere((line) => line.includes('mockprov/mock-alpha'));
  if (composer < 0 || banner === undefined || hints < 0 || status <= hints) return undefined;
  const first = banner.trimStart();
  const bannerKind: Layout['banner'] = first.startsWith('▌')
    ? 'bar'
    : first.startsWith('╭')
    ? 'box'
    : first.includes('mock-alpha')
    ? 'one-line'
    : 'two-line';
  const hintLine = lines[hints]!;
  return {
    glyph: lines[composer]!.includes('›') ? '›' : '❯',
    banner: bannerKind,
    ruleAbove: isRule(lines[composer - 1]),
    ruleBelow: isRule(lines[composer + 1]),
    boxedComposer: /^\s*│ .*│$/.test(lines[composer]!),
    hintSeparator: hintLine.includes('│') ? '│' : hintLine.includes('·') ? '·' : 'space',
    blankBeforeStatus: status - hints > 1,
    statusAlign: lines[status]!.length - lines[status]!.trimStart().length >= 30 ? 'right' : 'left',
  };
}

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
    // The idle screen is laid out as the skin lays it out: the facts only this skin has (see LAYOUTS).
    await expect
      .poll(() => layoutOf(session!.getVisibleOutput()), { timeout: 10_000, interval: 50 })
      .toEqual(LAYOUTS[skin]);

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
        activeProfileVersion: '3.0.0',
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
