// Local daemon launches through the built CLI (`TERM2_DAEMON_MODE=1` and `term2 daemon`). Every world
// isolates HOME, XDG and the runtime directory under its own temporary root; no case uses a shared
// directory such as /tmp itself as the conversations directory's parent.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

let world: World | undefined;
let provider: LoopbackProvider | undefined;
let daemon: ChildProcess | undefined;

afterEach(async () => {
  daemon?.kill('SIGKILL');
  daemon = undefined;
  await provider?.close();
  provider = undefined;
  // Also stops any daemon advertised under the world's runtime directory.
  removeWorld(world);
  world = undefined;
});

async function prepare(
  settings: Record<string, unknown> = {},
  turns: Parameters<typeof startLoopbackProvider>[0]['turns'] = [],
) {
  world = createWorld('term2-daemon-launch');
  provider = await startLoopbackProvider({ turns, reviewer: { approve: true, reasoning: 'fixture approves' } });
  writeWorldSettings(world, provider.baseUrl, { sandbox: { enabled: false }, ...settings });
  return world;
}

const cli = (env: NodeJS.ProcessEnv, args: string[]) => runCli({ ...world!, env }, integrationCliPath(), args);

it(
  'keeps a daemon for a TERM2_CONVERSATIONS_DIR store out of that directory’s parent',
  { timeout: 60_000 },
  async () => {
    const w = await prepare();
    // A parent other people use, like /tmp or a home directory, here inside the world's own root.
    const shared = path.join(w.root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o755);
    const env = { ...w.env, TERM2_CONVERSATIONS_DIR: path.join(shared, 'conversations') };

    daemon = spawn(process.execPath, [integrationCliPath(), 'daemon'], { env, cwd: w.workspace, stdio: 'ignore' });
    await expect
      .poll(async () => (await cli(env, ['daemon', 'status'])).status, { timeout: 20_000, interval: 100 })
      .toBe(0);

    // The daemon makes its state directory 0700 and keeps its lock there: never in the shared parent.
    expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(shared).filter((name) => name !== 'conversations')).toEqual([]);

    expect((await cli(env, ['daemon', 'stop'])).status).toBe(0);
    await expect.poll(() => daemon!.exitCode, { timeout: 10_000, interval: 50 }).not.toBeNull();
  },
);
