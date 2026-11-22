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

// The approval floor for the shell (docs/plans/approvals-and-sandbox/headless-approval-redesign.md,
// decision 3): with the real sandbox on, a shell command cannot write anything under the project's `.term2`
// (hooks, remembered sandbox read grants), not even by renaming `.term2` aside first, and cannot write the
// checkout's git hooks, although all of these sit inside the writable workspace. `floorWritePaths` in
// src/tools/shell/sandbox/sandbox-policy.ts denies `.term2`; the sandbox runtime itself denies `.git/hooks`
// where `.git` is a directory. File tools still write the rest of `.term2` (skills). The file-tool side of
// the floor is in workspace-write-boundary.integration.test.ts.
//
// Known gap, not asserted: renaming `.git` aside moves the runtime's `.git/hooks` mount with it.
//
// Not covered: `.git/config`, which the sandbox leaves writable (`allowGitConfig: true`) so git commands
// that record upstreams keep working; that is an open question in the plan.
//
// Not skipped when the sandbox tools are missing: the shell then asks for approval instead of running, and
// the control assertions fail. Linux only: the mounts are bubblewrap's.

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

type Step = { tool: string; args: Record<string, unknown> };
const shell = (command: string): Step => ({ tool: 'shell', args: { command, description: 'Write a file' } });

async function runSteps(w: World, steps: Step[]) {
  provider = await startLoopbackProvider({ turns: steps.map((call) => ({ call })) });
  writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: true } });
  const result = await runCli(w, integrationCliPath(), ['--profile', 'bare', 'Write the files']);
  const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
  expect(result.status, report).toBe(0);
  const results = toolResults(provider.requests().at(-1)).map((entry) => entry.text);
  expect(results, report).toHaveLength(steps.length);
  return results;
}

/** No file with content landed at any of these workspace paths on the host. */
function expectNotWritten(w: World, targets: string[]) {
  for (const target of targets) {
    const onHost = path.join(w.workspace, target);
    const written = fs.existsSync(onHost) && fs.statSync(onHost).isFile() && fs.statSync(onHost).size > 0;
    expect(written, target).toBe(false);
  }
}

const DENIED = /Read-only file system|Permission denied|Not a directory|Device or resource busy/;

it.skipIf(process.platform !== 'linux')(
  'a sandboxed shell cannot write .term2 or git hooks, even by renaming .term2 aside',
  { timeout: 60_000 },
  async () => {
    world = createWorld('term2-floorwrite');
    const w = world;
    fs.mkdirSync(path.join(w.workspace, '.term2', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(w.workspace, '.git', 'hooks'), { recursive: true });
    const results = await runSteps(w, [
      shell('mkdir -p .term2/hooks; printf x > .term2/hooks/pre.sh'),
      shell('printf x > .term2/sandbox-allow-paths.json'),
      shell('mv .term2 .t2old && mkdir -p .term2/hooks && printf x > .term2/hooks/renamed.sh'),
      shell('printf x > .git/hooks/pre-commit'),
      // Controls: a file tool still writes the rest of `.term2`, and the shell still writes the workspace.
      { tool: 'create_file', args: { path: '.term2/skills/note.md', content: 'ok\n' } },
      shell('printf ok > inside.txt && cat inside.txt'),
    ]);
    for (const [index, name] of ['hook', 'read grants', 'rename', 'git hook'].entries()) {
      expect(results[index], name).toMatch(/^exit [1-9]/);
      expect(results[index], name).toMatch(DENIED);
      expect(results[index], name).not.toContain('not approved');
    }
    expectNotWritten(w, [
      '.term2/hooks/pre.sh',
      '.term2/sandbox-allow-paths.json',
      '.term2/hooks/renamed.sh',
      '.git/hooks/pre-commit',
    ]);
    expect(fs.existsSync(path.join(w.workspace, '.t2old')), 'renamed aside').toBe(false);
    expect(results[4], 'file tool into .term2/skills').toContain('Created');
    expect(fs.readFileSync(path.join(w.workspace, '.term2', 'skills', 'note.md'), 'utf8')).toBe('ok\n');
    expect(results[5], 'workspace').toMatch(/^exit 0[\s\S]*ok/);
  },
);

it.skipIf(process.platform !== 'linux')(
  'without a .term2 directory, the shell cannot create one and a file tool still can',
  { timeout: 60_000 },
  async () => {
    world = createWorld('term2-floorwrite-none');
    const w = world;
    const results = await runSteps(w, [
      shell('mkdir -p .term2/hooks && printf x > .term2/hooks/pre.sh'),
      { tool: 'create_file', args: { path: '.term2/skills/note.md', content: 'ok\n' } },
    ]);
    expect(results[0]).toMatch(/^exit [1-9]/);
    expect(results[0]).toMatch(DENIED);
    expectNotWritten(w, ['.term2/hooks/pre.sh']);
    expect(results[1]).toContain('Created');
    expect(fs.readFileSync(path.join(w.workspace, '.term2', 'skills', 'note.md'), 'utf8')).toBe('ok\n');
  },
);
