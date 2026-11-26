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

// What the model sees when the real macOS sandbox denies a write. A tool's own error need not name the path
// (pnpm 12 reported only `Failed to open the store operation lock at "pnpm-store-operation-locks"`), so the
// shell result carries the kernel's denial (`<sandbox_violations>`, from the sandbox runtime's log monitor)
// and the sandbox escape instruction. A command that succeeds carries neither, although every sandboxed
// shell logs harmless denials.
//
// macOS only: the report comes from Seatbelt's kernel log. Not skipped when the sandbox is unavailable: the
// shell then asks for approval instead of running, and the assertions fail.

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

it.skipIf(process.platform !== 'darwin')(
  'a denied sandboxed write names the denied path; a successful command has no violation report',
  { timeout: 60_000 },
  async () => {
    // The sandbox proxy listens on a Unix socket under the child's TMPDIR, and macOS caps socket paths at
    // 104 bytes: a world under the per-user /var/folders temp directory is too deep for it.
    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = '/tmp';
    try {
      world = createWorld('t2v');
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
    const w = world;
    const deniedTarget = path.join(w.outside, 'denied.txt');
    const commands = [`printf x > ${deniedTarget}`, 'printf ok > "$TMPDIR/scratch.txt" && cat "$TMPDIR/scratch.txt"'];
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
    expect(results[0]).toMatch(/<sandbox_violations>[\s\S]*deny\(\d+\) file-write-create \S*denied\.txt/);
    expect(results[0]).not.toMatch(/deny\(\d+\) (?:sysctl-read|system-info) /);
    expect(results[0]).toContain('sandbox="unsandboxed"');
    expect(fs.existsSync(deniedTarget)).toBe(false);

    expect(results[1]).toMatch(/^exit 0[\s\S]*ok/);
    expect(results[1]).not.toContain('sandbox_violations');
  },
);
