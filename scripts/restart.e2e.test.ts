import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { expect, it } from 'vitest';
import {
  compiledIdentifier,
  patchCompiledModule as patchFixtureModule,
} from '../tests/helpers/patch-compiled-module.js';
import { listControlAdvertisements } from '../src/clients/control-socket/control-socket.js';
import {
  HANG_BACKSTOP_MS,
  READINESS_TIMEOUT_MS,
  createIsolatedWorkspaceLease,
  writePtyTextAndSubmit,
} from './provider-black-box/provider-test-harness.js';

// The real entry module (its anchors are patched below) in a private copy of the build tree.
function restartEntry(root: string): string {
  return join(
    root,
    'direct-dist',
    relative(resolve('dist'), resolve(process.env.TERM2_TEST_CLI ?? 'dist/src/app/cli.js')),
  );
}

it.skipIf(process.platform !== 'linux' || !process.execve)(
  'reloads changed compiled core in the same PTY process, retaining history and an empty latest leaf',
  async () => {
    const requests: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += String(chunk);
      });
      req.on('end', () => {
        if (req.url?.endsWith('/models')) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
          return;
        }
        requests.push(JSON.parse(raw));
        res.setHeader('Content-Type', 'text/event-stream');
        res.end(
          `data: ${JSON.stringify({
            id: 'fixture',
            object: 'chat.completion.chunk',
            model: 'fixture',
            choices: [
              { index: 0, delta: { role: 'assistant', content: 'restart-fixture-answer' }, finish_reason: 'stop' },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const workspace = await createIsolatedWorkspaceLease({
      env: {
        NODE_ENV: 'production',
        VITEST: undefined,
        AVA_PATH: undefined,
        JEST_WORKER_ID: undefined,
        TERM2_TEST_MODE: undefined,
        NODE_OPTIONS: undefined,
        SHELL_AUTO_APPROVE_MODE: 'off',
        SANDBOX_ENABLED: 'true',
        HERDR_PANE_ID: 'restart-owned-fixture',
      },
      prepare: async (root, paths) => {
        await mkdir(join(root, 'work'));
        await mkdir(join(root, 'runtime'), { mode: 0o700 });
        await mkdir(join(root, '.term2/hooks'), { recursive: true });
        await writeFile(
          join(root, '.term2/hooks/restart.mjs'),
          `import { appendFileSync } from 'node:fs';
export default function register(term2) { for (const type of ['session.start', 'session.end']) term2.on(type, event => appendFileSync(${JSON.stringify(
            join(root, 'hook-events.jsonl'),
          )}, JSON.stringify({type,pid:process.pid,sessionId:event.sessionId,herdr:process.env.HERDR_PANE_ID,approval:process.env.SHELL_AUTO_APPROVE_MODE,sandbox:process.env.SANDBOX_ENABLED}) + '\\n')); }`,
        );

        // Restart faults may delete the entry. Never mutate the runner's shared build.
        await cp(resolve('dist'), join(root, 'direct-dist'), { recursive: true });
        await cp(resolve('package.json'), join(root, 'package.json'));
        await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            providers: [
              {
                id: 'fixture-provider',
                name: 'Fixture',
                type: 'openai-compatible',
                baseUrl: `http://127.0.0.1:${address.port}`,
                apiKey: 'fixture-key',
              },
            ],
            agent: {
              modelSelection: { model: 'fixture', provider: 'fixture-provider' },
              completionVerification: false,
            },
            shell: { timeout: 23456 },
            memory: { enabled: false },
          }),
        );
      },
    });
    try {
      const entry = restartEntry(workspace.root);
      const child = await workspace.start({
        command: process.execPath,
        args: [entry, '--profile', 'bare', '--control-socket=reload'],
        env: { XDG_RUNTIME_DIR: join(workspace.root, 'runtime') },
        cwd: join(workspace.root, 'work'),
        cols: 180,
        rows: 50,
      });
      await child.waitForIdleInput();
      const cliPid = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/)[0]!;
      const identity = async () => {
        const stat = (await readFile(`/proc/${cliPid}/stat`, 'utf8')).split(' ');
        return {
          pid: stat[0],
          parent: stat[3],
          tty: stat[6],
          cgroup: await readFile(`/proc/${cliPid}/cgroup`, 'utf8'),
          fd0: await import('node:fs/promises').then((fs) => fs.readlink(`/proc/${cliPid}/fd/0`)),
        };
      };
      const before = await identity();
      const initialSettings = JSON.parse(await readFile(join(workspace.paths.logDir, 'settings.json'), 'utf8'));
      // Native writer authority is SQLite, not a legacy .lock sidecar. Read the
      // actual control binding; it follows /clear and survives exec via restart args.
      const activeLeaf = async () => listControlAdvertisements(join(workspace.root, 'runtime'))[0]!.sessionId;
      const original = await activeLeaf();
      const beforeFirstTurn = child.readIdleGeneration();
      await writePtyTextAndSubmit(child, 'history-before-restart');
      await child.waitForVisibleOutput('restart-fixture-answer');
      await child.waitForIdleInput({ after: beforeFirstTurn });
      // Compile a changed real command module to the current entry's build tree.
      // The old process already imported A; only a fresh core can show B.
      // Change a real command diagnostic that /help reaches, after the running process has imported it.
      await patchFixtureModule(
        join(workspace.root, 'direct-dist/src/clients/tui/menus/legacy-commands.js'),
        'Exit the application',
        'Changed compiled core B',
      );
      await writePtyTextAndSubmit(child, '/auto-approve advisory');
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(workspace.paths.logDir, 'settings.json'), 'utf8')).shell?.autoApproveMode,
          { timeout: READINESS_TIMEOUT_MS },
        )
        .toBe('advisory');
      // Sandbox execution (and its /sandbox command) is an accepted difference: legacy only.
      const savedSettings = JSON.parse(await readFile(join(workspace.paths.logDir, 'settings.json'), 'utf8'));
      expect(savedSettings.providers).toEqual(initialSettings.providers);
      expect(savedSettings.agent).toEqual(initialSettings.agent);
      expect(savedSettings.app).toEqual(initialSettings.app);
      expect(savedSettings.memory).toEqual(initialSettings.memory);
      expect(savedSettings.shell.timeout).toBe(23456);
      await writePtyTextAndSubmit(child, '/restart');
      await child.waitForVisibleOutput('Restart recovery command:');
      // Exec resets the idle counter, so the old generation is not an after token.
      await child.waitForState((snapshot) => snapshot.visibleOutput.includes('Resumed conversation'));
      await child.waitForIdleInput();
      await expect.poll(() => child.readComposerRevision(), { timeout: READINESS_TIMEOUT_MS }).toBe(1);
      expect(await identity()).toEqual(before);
      expect(await activeLeaf()).toBe(original);
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Changed compiled core B');
      const turnIdle = child.readIdleGeneration();
      await writePtyTextAndSubmit(child, 'history-after-restart');
      await child.waitForState(() => requests.length === 2);
      expect(JSON.stringify(requests[1])).toContain('history-before-restart');
      await child.waitForIdleInput({ after: turnIdle });
      await writePtyTextAndSubmit(child, '/clear');
      await expect.poll(activeLeaf, { timeout: READINESS_TIMEOUT_MS }).not.toBe(original);
      const latest = await activeLeaf();
      expect(latest).not.toBe(original);
      const emptyLeaf = await readFile(join(workspace.paths.conversationsDir, `${latest}.jsonl`), 'utf8');
      expect(
        emptyLeaf
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).fact.type),
      ).toEqual(['session_started']);
      const resumeCount = child.getVisibleOutput().split('Resumed conversation:').length;
      await writePtyTextAndSubmit(child, '/restart');
      await child.waitForState(
        (snapshot) => snapshot.visibleOutput.split('Resumed conversation:').length > resumeCount,
      );
      await child.waitForIdleInput();
      // A functional command is also an input/raw-mode check after the second exec.
      await expect.poll(() => child.readComposerRevision(), { timeout: READINESS_TIMEOUT_MS }).toBe(1);
      const helpOutputOffset = child.getVisibleOutput().length;
      const beforeHelpRevision = child.readComposerRevision();
      await writePtyTextAndSubmit(child, '/help');
      // Old help output is still in the PTY history; wait for this command and
      // its composer clear before the next input can share a chunk with Enter.
      await child.waitForState(
        (snapshot) => snapshot.visibleOutput.slice(helpOutputOffset).includes('Changed compiled core B'),
        5000,
      );
      await child.waitForComposerValue('', { afterRevision: beforeHelpRevision, timeoutMs: 5000 });
      expect(await identity()).toEqual(before);
      expect(await activeLeaf()).toBe(latest);
      const afterRestart = await readFile(join(workspace.paths.conversationsDir, `${latest}.jsonl`), 'utf8');
      expect(afterRestart).toContain(latest);
      // Native resumes the empty leaf without appending a fact.
      expect(afterRestart).toBe(emptyLeaf);
      expect(requests).toHaveLength(2);
      await writePtyTextAndSubmit(child, '/quit');
      expect((await child.waitForExit()).exitCode).toBe(0);
      const hooks = (await readFile(join(workspace.root, 'hook-events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(hooks.map((event) => event.type)).toEqual([
        'session.start',
        'session.end',
        'session.start',
        'session.end',
        'session.start',
        'session.end',
      ]);
      expect(new Set(hooks.map((event) => event.pid))).toEqual(new Set([Number(before.pid)]));
      expect(hooks.every((event) => event.herdr === 'restart-owned-fixture')).toBe(true);
      expect(hooks[2]).toMatchObject({ approval: 'advisory' });
    } finally {
      await workspace.cleanup();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
  HANG_BACKSTOP_MS,
);

it.each(['runner', 'missing-entry', 'cleanup', 'lock', 'writer-close', 'native-exec'] as const)(
  'handles %s failure without replaying input or attempting replacement',
  async (fault) => {
    const workspace = await createIsolatedWorkspaceLease({
      env: {
        NODE_ENV: 'production',
        VITEST: undefined,
        AVA_PATH: undefined,
        JEST_WORKER_ID: undefined,
        TERM2_TEST_MODE: undefined,
        NODE_OPTIONS: undefined,
      },
      prepare: async (root, paths) => {
        await mkdir(join(root, 'work'));
        await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
        // Restart faults may delete the entry. Never mutate the runner's shared build.
        await cp(resolve('dist'), join(root, 'direct-dist'), { recursive: true });
        await cp(resolve('package.json'), join(root, 'package.json'));
        await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir');
        await mkdir(paths.logDir, { recursive: true });
        await writeFile(
          join(paths.logDir, 'settings.json'),
          JSON.stringify({
            providers: [
              {
                id: 'fixture-provider',
                name: 'Fixture',
                type: 'openai-compatible',
                baseUrl: 'http://127.0.0.1:9',
                apiKey: 'fixture-key',
              },
            ],
            agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' } },
            memory: { enabled: false },
          }),
        );
        const cli = restartEntry(root);
        // The same faults at next's own seams: exit observer, session shutdown, writer lock.
        const tui = join(root, 'direct-dist/src/app/launch-tui.js');
        const pending = await compiledIdentifier(tui, 'pending');
        await patchFixtureModule(
          cli,
          'void main(process.argv.slice(2))',
          `process.on('exit', code => process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(
            join(root, 'node-exit-code'),
          )}, String(code)));\nvoid main(process.argv.slice(2))`,
        );
        if (fault === 'cleanup')
          await patchFixtureModule(
            tui,
            'await app.close();',
            `if (${pending}.plan) throw new Error('fixture cleanup failure');\nawait app.close();`,
          );
        if (fault === 'lock')
          // Hold the session's writer lock past shutdown, as a leaked writer would.
          await patchFixtureModule(
            tui,
            'await app.close();',
            `await app.close();\nif (${pending}.plan) globalThis.fixtureLock = (await import('../session/writer-lock.js')).acquireDirectWriterLock(process.getBuiltinModule('node:path').join(conversationsDir, \`\${${pending}.plan.sessionId}.jsonl\`));`,
          );
        if (fault === 'writer-close')
          await patchFixtureModule(
            tui,
            'await app.close();',
            `await app.close();\nif (${pending}.plan) throw new Error('fixture writer close failure');`,
          );
        if (fault === 'native-exec')
          await patchFixtureModule(
            join(root, 'direct-dist/src/app/launch-tui-restart.js'),
            'process.execve?.(process.execPath,',
            `process.execve?.(${JSON.stringify(join(root, 'missing-node'))},`,
          );
      },
    });
    try {
      const entry = restartEntry(workspace.root);
      const child = await workspace.start({
        command: process.execPath,
        args: [...(fault === 'runner' ? ['--trace-warnings'] : []), entry, '--profile', 'bare'],
        cwd: join(workspace.root, 'work'),
        cols: 180,
        rows: 50,
      });
      await child.waitForIdleInput();
      if (fault === 'missing-entry') await import('node:fs/promises').then((fs) => fs.unlink(entry));
      await writePtyTextAndSubmit(child, '/restart');
      if (fault === 'runner' || fault === 'missing-entry') {
        await child.waitForVisibleOutput('Manual resume:');
        await writePtyTextAndSubmit(child, '/help');
        await child.waitForVisibleOutput('Keyboard shortcuts');
        await writePtyTextAndSubmit(child, '/quit');
        expect((await child.waitForExit()).exitCode).toBe(0);
      } else if (fault === 'native-exec') {
        await child.waitForVisibleOutput('Restart recovery command:');
        await child.waitForExit();
        expect(child.getVisibleOutput()).not.toContain('Resumed conversation:');
        expect((await readdir(workspace.paths.conversationsDir)).some((file) => file.endsWith('.jsonl'))).toBe(true);
      } else {
        await child.waitForVisibleOutput('Restart cleanup failed; no replacement attempted:');
        await child.waitForExit();
        expect(await readFile(join(workspace.root, 'node-exit-code'), 'utf8')).toBe('1');
        const logs = (await readdir(workspace.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
        expect(logs).toHaveLength(1);
        // term2-next's own store starts with a session_started fact, legacy's with session_init.
        expect(await readFile(join(workspace.paths.conversationsDir, logs[0]!), 'utf8')).toContain('session_started');
        expect(child.getVisibleOutput()).not.toContain('Resumed conversation:');
        expect(child.getVisibleOutput()).toContain('Restart recovery command:');
      }
    } finally {
      await workspace.cleanup();
    }
  },
  HANG_BACKSTOP_MS,
);
