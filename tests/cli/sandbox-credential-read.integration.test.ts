import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
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

// The real shell sandbox hides credential paths from a sandboxed command: the built CLI runs with the
// sandbox ON (default settings; bubblewrap on Linux, Seatbelt on macOS) and a loopback provider plays a
// model that tries to `cat` fake secrets planted in the test's throwaway HOME. `denyRead` in
// src/tools/shell/sandbox/sandbox-policy.ts lists the paths (`~/.ssh`, `~/.aws`, `~/.netrc`, ...), and
// docs/reference/shell-sandbox.md promises "common credential files remain protected" and that
// inherited credentials are filtered. The stub-runner denied-read tests in
// tests/tools/system/run-code/shell.integration.test.ts never reach the real sandbox.
//
// Why the denial is the sandbox's, as root or not: every fixture file is mode 0644 and owned by the test
// user, and the test reads each back from the host first, so Unix permissions allow the read. A command
// that still cannot see the sentinel was stopped by the sandbox's mounts. The controls (a workspace file
// and an ordinary home file) show the shell ran and that only the credential paths are hidden.
//
// Not skipped when the sandbox tools are missing: the shell then asks for approval instead of running
// the command, the denial and control assertions fail, and the lane that should have the tools says so.
// Runs in the `integration` lane's file set; CI's `test` and `integration` jobs install bubblewrap/socat.
//
// Linux only for now: the mounts described above are bubblewrap's. Seatbelt on macOS has not been run with it.

let world: World | undefined;
let provider: LoopbackProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  removeWorld(world);
  world = undefined;
});

const SENTINEL = 'TERM2-FAKE-SECRET-SENTINEL';
// Directories are replaced by an empty mount and files are masked, so the shell reports one of these.
const DENIAL = /No such file or directory|Permission denied|Operation not permitted/;

it.skipIf(process.platform !== 'linux')(
  'hides credential files and env secrets from a sandboxed command while ordinary reads work',
  {
    timeout: 60_000,
  },
  async () => {
    world = createWorld('term2-credread');
    const w = world;
    const secrets = [
      path.join(w.home, '.ssh', 'id_fixture'),
      path.join(w.home, '.aws', 'credentials'),
      path.join(w.home, '.netrc'),
      // Term2's own secrets (headless-approval-redesign.md, decision 5). The settings and config
      // directories are denied whole, so a file no list names (here a `.corrupt-*` copy) is hidden too.
      path.join(resolveSettingsDirectory({ homeDir: w.home, env: w.env }), 'settings.json.corrupt-1'),
      path.join(w.env.TERM2_CONFIG_DIR!, 'codex-auth.json'),
      // Other agents' token files.
      path.join(w.home, '.codex', 'auth.json'),
      path.join(w.home, '.claude', '.credentials.json'),
    ];
    for (const file of secrets) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${SENTINEL} ${path.basename(file)}\n`, { mode: 0o644 });
      expect(fs.readFileSync(file, 'utf8'), 'fixture must be readable from the host').toContain(SENTINEL);
    }
    const homeControl = path.join(w.home, 'notes.txt');
    const workspaceControl = path.join(w.workspace, 'ordinary.txt');
    fs.writeFileSync(homeControl, 'HOME-CONTROL-OK\n');
    fs.writeFileSync(workspaceControl, 'WORKSPACE-CONTROL-OK\n');
    // An inherited credential: the sandbox environment keeps only an allowlist of variables.
    w.env.AWS_SECRET_ACCESS_KEY = `${SENTINEL}-env`;

    // The live settings file: the host reads it to run, the sandboxed command must not.
    const settingsFile = path.join(resolveSettingsDirectory({ homeDir: w.home, env: w.env }), 'settings.json');
    const commands = [
      ...secrets.map((file) => `cat ${file}`),
      'echo "env=[$AWS_SECRET_ACCESS_KEY]"',
      // The project cache lives under the denied settings directory; it must stay usable.
      'echo CACHE-CONTROL-OK > "$XDG_CACHE_HOME/probe" && cat "$XDG_CACHE_HOME/probe"',
      `cat ${homeControl}`,
      `cat ${workspaceControl}`,
      `cat ${settingsFile}`,
    ];
    provider = await startLoopbackProvider({
      turns: commands.map((command) => ({ call: { tool: 'shell', args: { command, description: 'Read a fixture' } } })),
    });
    writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: true } });
    expect(fs.existsSync(settingsFile)).toBe(true);
    const result = await runCli(w, integrationCliPath(), ['--profile', 'bare', 'Read the fixture files']);
    const requests = provider.requests();
    const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
    expect(result.status, report).toBe(0);
    expect(requests, report).toHaveLength(commands.length + 1);

    const results = toolResults(requests.at(-1)).map((entry) => entry.text);
    expect(results, report).toHaveLength(commands.length);
    // Each credential read failed with a denial, not an approval refusal or a missing sandbox.
    for (const [index, file] of secrets.entries()) {
      expect(results[index], file).toMatch(/^exit [1-9]/);
      expect(results[index], file).toContain(file);
      expect(results[index], file).toMatch(DENIAL);
      expect(results[index], file).not.toContain('not approved');
    }
    // The inherited secret did not reach the command's environment.
    expect(results[secrets.length]).toMatch(/^exit 0[\s\S]*env=\[\]/);
    expect(results[secrets.length + 1], 'project cache').toMatch(/^exit 0[\s\S]*CACHE-CONTROL-OK/);
    // Controls: the same shell, in the same run, reads ordinary files.
    expect(results.at(-3)).toMatch(/^exit 0[\s\S]*HOME-CONTROL-OK/);
    expect(results.at(-2)).toMatch(/^exit 0[\s\S]*WORKSPACE-CONTROL-OK/);
    // The live settings.json is hidden although the CLI read it to start this run.
    expect(results.at(-1), settingsFile).toMatch(/^exit [1-9]/);
    expect(results.at(-1), settingsFile).toMatch(DENIAL);
    expect(results.at(-1), settingsFile).not.toContain(provider.baseUrl);

    // Nothing carrying a sentinel reached the model, the terminal, or the log streams.
    expect(JSON.stringify([requests, provider.reviews()])).not.toContain(SENTINEL);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
  },
);
