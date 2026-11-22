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
// decision 3): with the real sandbox on, a shell command cannot write the project's hooks, its remembered
// sandbox read grants or the checkout's git hooks, although all three sit inside the writable workspace.
// `floorWritePaths` in src/tools/shell/sandbox/sandbox-policy.ts adds the first two; the sandbox runtime
// itself denies `.git/hooks` where `.git` is a directory. The file-tool side of the floor is in
// workspace-write-boundary.integration.test.ts.
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

it.skipIf(process.platform !== 'linux')(
  'a sandboxed shell cannot write hooks or remembered read grants inside the workspace',
  { timeout: 60_000 },
  async () => {
    world = createWorld('term2-floorwrite');
    const w = world;
    fs.mkdirSync(path.join(w.workspace, '.term2', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(w.workspace, '.git', 'hooks'), { recursive: true });
    const floor = [
      path.join('.term2', 'hooks', 'pre.sh'),
      path.join('.term2', 'sandbox-allow-paths.json'),
      path.join('.git', 'hooks', 'pre-commit'),
    ];
    const commands = [
      ...floor.map((target) => `mkdir -p ${path.dirname(target)}; printf x > ${target}`),
      // Controls: the rest of `.term2` and the workspace stay writable in the same run.
      'printf ok > .term2/skills/note.md && cat .term2/skills/note.md',
      'printf ok > inside.txt && cat inside.txt',
    ];
    provider = await startLoopbackProvider({
      turns: commands.map((command) => ({ call: { tool: 'shell', args: { command, description: 'Write a file' } } })),
    });
    writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: true } });
    const result = await runCli(w, integrationCliPath(), ['--profile', 'bare', 'Write the files']);
    const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
    expect(result.status, report).toBe(0);
    const results = toolResults(provider.requests().at(-1)).map((entry) => entry.text);
    expect(results, report).toHaveLength(commands.length);

    floor.forEach((target, index) => {
      expect(results[index], target).toMatch(/^exit [1-9]/);
      expect(results[index], target).toMatch(/Read-only file system|Permission denied|Not a directory/);
      expect(results[index], target).not.toContain('not approved');
      const onHost = path.join(w.workspace, target);
      expect(fs.existsSync(onHost) && fs.statSync(onHost).isFile() && fs.statSync(onHost).size > 0, target).toBe(false);
    });
    expect(results.at(-2), 'rest of .term2').toMatch(/^exit 0[\s\S]*ok/);
    expect(results.at(-1), 'workspace').toMatch(/^exit 0[\s\S]*ok/);
  },
);
