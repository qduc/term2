import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  readHarnessApprovalReady,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import {
  createWorld,
  removeWorld,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

// The workspace write boundary with a person answering: in the interactive UI (approval mode off, sandbox
// off) a write outside the launch directory stops at a prompt that names the tool and the target, nothing
// is written while it is open, Deny keeps the file from existing and tells the model so, and Allow once
// writes exactly that file. The second write goes out through a symlink inside the workspace, which a path
// check on the text alone would call inside. The headless refusals are in
// workspace-write-boundary.integration.test.ts.
const builtCli = testCliPath(
  path.join(fileURLToPath(new URL('../..', import.meta.url)), 'dist', 'src', 'app', 'cli.js'),
);

let world: World | undefined;
let provider: LoopbackProvider | undefined;
let session: TerminalSession | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

it(
  'asks before an outside write, writes nothing while it waits, and obeys the answer',
  { timeout: 60_000 },
  async () => {
    world = createWorld('term2-boundary-e2e');
    const w = world;
    fs.symlinkSync(w.outside, path.join(w.workspace, 'linkdir'));
    const denied = path.join(w.outside, 'denied.txt');
    const allowed = path.join(w.outside, 'allowed.txt');
    const idlePath = path.join(w.home, 'input-idle');
    provider = await startLoopbackProvider({
      turns: [
        { call: { tool: 'create_file', args: { path: denied, content: 'denied-content' } } },
        { text: 'FIRST-DONE' },
        { call: { tool: 'create_file', args: { path: 'linkdir/allowed.txt', content: 'allowed-content' } } },
        { text: 'SECOND-DONE' },
      ],
    });
    writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: false } });
    session = spawnTerminal('node', [builtCli], {
      cwd: w.workspace,
      env: { ...w.env, [HARNESS_IDLE_ENV]: idlePath },
      cols: 100,
      rows: 34,
    });
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text);
      session!.write('\r');
    };
    await submit('write the first file');

    // Prompt 1: the absolute path outside the workspace. Answer once the prompt owns input.
    await expect
      .poll(() => readHarnessApprovalReady(idlePath)?.revision, {
        timeout: 30_000,
        message: 'the outside write must stop at an approval prompt',
      })
      .toBe(1);
    await session.waitForOutput('Agent wants to run: create_file', 30_000);
    await session.waitForOutput(`[CREATE] ${denied}`, 30_000);
    await session.waitForOutput('manual approval required', 30_000);
    expect(fs.existsSync(denied)).toBe(false);
    session.write('n');
    // Denying asks for an optional reason; an empty one is a plain denial.
    await session.waitForOutput('Why?', 30_000);
    session.write('\r');
    await session.waitForOutput('FIRST-DONE', 30_000);
    expect(fs.existsSync(denied)).toBe(false);
    const [firstResult] = toolResults(provider.requests()[1]);
    expect(firstResult?.text).toContain('not approved');

    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 30_000 });
    await submit('write the second file');

    // Prompt 2: a path that looks inside the workspace but resolves outside it through a symlink.
    await expect
      .poll(() => readHarnessApprovalReady(idlePath)?.revision, {
        timeout: 30_000,
        message: 'a write through a symlink out of the workspace must stop at an approval prompt',
      })
      .toBe(2);
    await session.waitForOutput('[CREATE] linkdir/allowed.txt', 30_000);
    expect(fs.existsSync(allowed)).toBe(false);
    session.write('y');
    await session.waitForOutput('SECOND-DONE', 30_000);
    expect(fs.readFileSync(allowed, 'utf8')).toBe('allowed-content');
    expect(fs.existsSync(denied)).toBe(false);
    expect(fs.readdirSync(w.outside)).toEqual(['allowed.txt']);
  },
);
