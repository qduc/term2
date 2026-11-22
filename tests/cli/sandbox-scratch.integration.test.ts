import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

// The scratch area with the real sandbox on (docs/plans/approvals-and-sandbox/headless-approval-redesign.md,
// decision 4): a write to plain /tmp fails on the sandbox's read-only mount, and the error the model sees
// names $TMPDIR (`scratchDirectoryHint`, added by the sandbox runner's `annotateFailure`); a write to
// $TMPDIR works. The sandbox-off side is in workspace-write-boundary.integration.test.ts.
//
// Not skipped when the sandbox tools are missing: the shell then asks for approval instead of running, and
// the assertions fail. Linux only: the mounts are bubblewrap's.

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

it.skipIf(process.platform !== 'linux')(
  'a sandboxed write to plain /tmp fails and names $TMPDIR; a write to $TMPDIR works',
  { timeout: 60_000 },
  async () => {
    world = createWorld('term2-scratch');
    const w = world;
    // The world is under /tmp and outside the child's scratch area, so this is a plain /tmp target.
    const sharedTarget = path.join(w.outside, 'shared.txt');
    expect(sharedTarget.startsWith('/tmp/')).toBe(true);
    const commands = [`printf x > ${sharedTarget}`, 'printf ok > "$TMPDIR/scratch.txt" && cat "$TMPDIR/scratch.txt"'];
    provider = await startLoopbackProvider({
      turns: commands.map((command) => ({ call: { tool: 'shell', args: { command, description: 'Write a file' } } })),
    });
    writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: true } });
    const result = await runCli(w, integrationCliPath(), ['--profile', 'bare', 'Write the files']);
    const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
    expect(result.status, report).toBe(0);
    const results = toolResults(provider.requests().at(-1)).map((entry) => entry.text);
    expect(results, report).toHaveLength(commands.length);

    expect(results[0]).toMatch(/^exit [1-9]/);
    expect(results[0]).toContain('Read-only file system');
    expect(results[0]).toContain('Use $TMPDIR');
    expect(fs.existsSync(sharedTarget)).toBe(false);
    expect(results[1]).toMatch(/^exit 0[\s\S]*ok/);
  },
);
