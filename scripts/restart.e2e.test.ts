import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-black-box/provider-test-harness.js';

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
        await mkdir(join(root, '.term2/hooks'), { recursive: true });
        await writeFile(
          join(root, '.term2/hooks/restart.mjs'),
          `import { appendFileSync } from 'node:fs';
export default function register(term2) { for (const type of ['session.start', 'session.end']) term2.on(type, event => appendFileSync(${JSON.stringify(
            join(root, 'hook-events.jsonl'),
          )}, JSON.stringify({type,pid:process.pid,sessionId:event.sessionId,herdr:process.env.HERDR_PANE_ID,approval:process.env.SHELL_AUTO_APPROVE_MODE,sandbox:process.env.SANDBOX_ENABLED}) + '\\n')); }`,
        );

        await cp(resolve('dist'), join(root, 'dist'), { recursive: true });
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
            memory: { enabled: false },
          }),
        );
      },
    });
    try {
      const entry = join(workspace.root, 'dist/cli.js');
      const child = await workspace.start({
        command: process.execPath,
        args: [entry, '--profile', 'bare'],
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
      const activeLeaf = async () =>
        (await readdir(workspace.paths.conversationsDir))
          .find((file) => file.endsWith('.lock'))!
          .replace(/\.lock$/, '');
      const original = await activeLeaf();
      const beforeFirstTurn = child.readIdleGeneration();
      await writePtyTextAndSubmit(child, 'history-before-restart');
      await child.waitForVisibleOutput('restart-fixture-answer');
      await child.waitForIdleInput({ after: beforeFirstTurn });
      // Compile a changed real command module to the current entry's build tree.
      // The old process already imported A; only a fresh core can show B.
      const source = (await readFile(resolve('source/commands/quit-command.ts'), 'utf8')).replace(
        'Exit the application',
        'Changed compiled core B',
      );
      const built = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      });
      await writeFile(join(workspace.root, 'dist/commands/quit-command.js'), built.outputText);
      await writePtyTextAndSubmit(child, '/auto-approve advisory');
      await expect
        .poll(
          async () =>
            JSON.parse(await readFile(join(workspace.paths.logDir, 'settings.json'), 'utf8')).shell?.autoApproveMode,
          { timeout: 5000 },
        )
        .toBe('advisory');
      await writePtyTextAndSubmit(child, '/sandbox');
      await child.waitForVisibleOutput('Shell sandbox mode disabled');
      await writePtyTextAndSubmit(child, '/restart');
      await child.waitForVisibleOutput('Restart recovery command:');
      // Exec resets the idle counter, so the old generation is not an after token.
      await child.waitForState((snapshot) => snapshot.visibleOutput.includes('Resumed conversation'));
      await child.waitForIdleInput();
      await expect.poll(() => child.readComposerRevision(), { timeout: 5000 }).toBe(1);
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
      await child.waitForVisibleOutput('Welcome to term²!');
      await expect.poll(activeLeaf, { timeout: 5000 }).not.toBe(original);
      const latest = await activeLeaf();
      expect(latest).not.toBe(original);
      const resumeCount = child.getVisibleOutput().split('Resumed conversation:').length;
      await writePtyTextAndSubmit(child, '/restart');
      await child.waitForState(
        (snapshot) => snapshot.visibleOutput.split('Resumed conversation:').length > resumeCount,
      );
      await child.waitForIdleInput();
      // A functional command is also an input/raw-mode check after the second exec.
      await expect.poll(() => child.readComposerRevision(), { timeout: 5000 }).toBe(1);
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForState((snapshot) => snapshot.visibleOutput.split('Changed compiled core B').length >= 3);
      expect(await identity()).toEqual(before);
      expect(await activeLeaf()).toBe(latest);
      expect(await readFile(join(workspace.paths.conversationsDir, `${latest}.jsonl`), 'utf8')).toContain(latest);
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
      expect(hooks[2]).toMatchObject({ approval: 'advisory', sandbox: 'false' });
    } finally {
      await workspace.cleanup();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
  60_000,
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
        const cli = join(root, 'dist/cli.js');
        let code = (await readFile(cli, 'utf8')).replace(
          'const controlArgv',
          `process.on('exit', code => fs.writeFileSync(${JSON.stringify(
            join(root, 'node-exit-code'),
          )}, String(code)));\nconst controlArgv`,
        );
        if (fault === 'cleanup')
          code = code.replace(
            'await conversationService.shutdown();',
            "if (restartPlan) throw new Error('fixture cleanup failure');\nawait conversationService.shutdown();",
          );
        if (fault === 'lock')
          code = code.replace(
            'await logWriter.close();',
            "await logWriter.close();\nif (restartPlan) fs.writeFileSync(getConversationLockPath(logWriter.sessionId), 'fixture lock unlink failure');",
          );
        if (fault === 'writer-close')
          code = code.replace(
            'await logWriter.close();',
            "await logWriter.close();\nif (restartPlan) throw new Error('fixture writer close failure');",
          );
        if (fault === 'native-exec')
          code = code.replace(
            'process.execve(process.execPath,',
            `process.execve(${JSON.stringify(join(root, 'missing-node'))},`,
          );
        await writeFile(cli, code);
      },
    });
    try {
      const entry = join(workspace.root, 'dist/cli.js');
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
        expect(await readFile(join(workspace.paths.conversationsDir, logs[0]!), 'utf8')).toContain('init');
        expect(child.getVisibleOutput()).not.toContain('Resumed conversation:');
        expect(child.getVisibleOutput()).toContain('Restart recovery command:');
      }
    } finally {
      await workspace.cleanup();
    }
  },
  30_000,
);
