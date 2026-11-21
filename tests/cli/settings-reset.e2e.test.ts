import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import {
  createWorld,
  removeWorld,
  startLoopbackProvider,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

// `/settings reset <key>` in the built terminal UI: a setting that was changed away from its default goes back
// to it on disk and in the running session, and the user is told. The command takes exactly one key:
//   - typed, `/settings reset <key>` opens the "Reset settings" list narrowed to that key, and Enter resets it
//     ("Reset <label> to default"); a key that matches nothing resets nothing;
//   - there is no reset-all form in the terminal UI.
// The child runs with NODE_ENV=production because settings are only written to disk outside test mode.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;
const READY_MS = 60_000;

let session: TerminalSession | null = null;
let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  session?.dispose();
  session = null;
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

/** Launch the terminal UI against a loopback provider, with `settings` already saved in settings.json. */
async function start(settings: Record<string, unknown>, turnCount = 0) {
  world = createWorld('term2-settings-reset');
  provider = await startLoopbackProvider({
    turns: Array.from({ length: turnCount }, (_, index) => ({ text: `ANSWER-${index + 1}` })),
  });
  writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false }, ...settings });
  const idlePath = path.join(world.home, 'input-idle');
  const settingsFile = path.join(resolveSettingsDirectory({ homeDir: world.home, env: world.env }), 'settings.json');
  session = spawnTerminal('node', [builtCli, '--profile', 'bare'], {
    cwd: world.workspace,
    env: {
      ...world.env,
      NODE_ENV: 'production',
      [HARNESS_IDLE_ENV]: idlePath,
    },
    cols: 100,
    rows: 30,
  });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: READY_MS });
  const saved = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, any>;
  /** What the terminal drew since `action` was taken, once it contains `needle`. */
  const fresh = async (action: () => void | Promise<void>, needle: string | RegExp): Promise<string> => {
    const offset = session!.getVisibleOutput().length;
    await action();
    const drawn = expect.poll(() => session!.getVisibleOutput().slice(offset), { timeout: READY_MS, interval: 25 });
    await (typeof needle === 'string' ? drawn.toContain(needle) : drawn.toMatch(needle));
    return session!.getVisibleOutput().slice(offset);
  };
  const typeCommand = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: READY_MS });
  };
  /** Send a prompt and wait for the scripted answer to be drawn, so the next request is one after any setting change. */
  let answers = 0;
  const ask = async (text: string) => {
    await typeCommand(text);
    answers += 1;
    await fresh(() => session!.write('\r'), `ANSWER-${answers}`);
  };
  return { idlePath, saved, fresh, typeCommand, ask };
}

describe('/settings reset <key>', () => {
  it(
    'puts a changed setting back to its default on disk, tells the user, and leaves other settings alone',
    { timeout: TIMEOUT_MS },
    async () => {
      const { idlePath, saved, fresh, typeCommand } = await start({
        tools: { maxOutputChars: 5000 },
        shell: { timeout: 1234 },
      });
      expect(saved().tools.maxOutputChars).toBe(5000);

      // The reset list shows the setting as changed, with the default it would go back to.
      const before = await fresh(() => typeCommand('/settings reset tools.maxOutputChars'), 'default: 20,000 chars');
      expect(before).toContain('Reset settings');
      expect(before).toMatch(/Tool output chars\s+● 5,000 chars/);

      const notice = await fresh(() => session!.write('\r'), 'Reset Tool output chars to default');
      expect(notice).not.toMatch(/rror/);
      await waitForHarnessComposerValue(idlePath, '', { timeoutMs: READY_MS });

      // On disk: back to the default; the other changed setting is untouched.
      await expect.poll(() => saved().tools.maxOutputChars, { timeout: READY_MS }).toBe(20000);
      expect(saved().shell.timeout).toBe(1234);

      // In the running session: asked again, the list no longer marks it changed and shows the default.
      const after = await fresh(
        () => typeCommand('/settings reset tools.maxOutputChars'),
        /Tool output chars\s+\S*\s*20,000 chars/,
      );
      expect(after).toMatch(/Tool output chars\s+20,000 chars/);
      expect(after).not.toContain('5,000 chars');
    },
  );

  it('applies a reset to the next model request of the running session', { timeout: TIMEOUT_MS }, async () => {
    const { saved, fresh, ask, typeCommand, idlePath } = await start({ agent: { reasoningEffort: 'high' } }, 2);
    const effortOf = (index: number) =>
      (provider!.requests()[index] as unknown as { reasoning_effort?: string } | undefined)?.reasoning_effort;

    await ask('first question');
    expect(provider!.requests()).toHaveLength(1);
    expect(effortOf(0)).toBe('high');

    await typeCommand('/settings reset agent.reasoningEffort');
    await fresh(() => session!.write('\r'), 'Reset Reasoning effort to default');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: READY_MS });
    await expect.poll(() => saved().agent.reasoningEffort, { timeout: READY_MS }).toBe('default');

    await ask('second question');
    expect(provider!.requests()).toHaveLength(2);
    expect(effortOf(1)).toBeUndefined();
  });

  it('resets nothing for a key that matches no setting', { timeout: TIMEOUT_MS }, async () => {
    const { saved, fresh, typeCommand } = await start({ tools: { maxOutputChars: 5000 } });
    const before = JSON.stringify(saved());
    const output = await fresh(() => typeCommand('/settings reset not.a.setting'), 'No settings match');
    expect(output).not.toContain('to default');
    // Enter on an empty list is a no-op: no notice is drawn and nothing is saved. A key typed right after the Enter
    // would be read together with it and prove nothing, so this waits out a window instead.
    session!.write('\r');
    // sleep-ok: observes that no "Reset ... to default" notice follows; a real reset draws its notice from the same
    // Enter (the first test waits for it with no delay), so 500 ms is a generous window for it to have appeared.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session!.getVisibleOutput()).not.toMatch(/Reset .* to default/);
    expect(JSON.stringify(saved())).toBe(before);
  });
});
