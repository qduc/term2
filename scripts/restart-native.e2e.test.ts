/** Native counterparts to legacy-storage restart probes. No legacy facts or sidecars are seeded. */
import { patchCompiledModule } from '../tests/helpers/patch-compiled-module.js';
import { copyBuiltCli } from '../tests/helpers/copy-built-cli.js';
import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { listControlAdvertisements } from '../src/clients/control-socket/control-socket.js';
import { createIsolatedWorkspaceLease, writePtyTextAndSubmit } from './provider-black-box/provider-test-harness.js';

const productionEnv = {
  NODE_ENV: 'production',
  VITEST: undefined,
  AVA_PATH: undefined,
  JEST_WORKER_ID: undefined,
  TERM2_TEST_MODE: undefined,
  NODE_OPTIONS: undefined,
};
const reply = (content: string) =>
  `data: ${JSON.stringify({
    id: 'fixture',
    object: 'chat.completion.chunk',
    model: 'fixture',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`;

/** One chat-completions chunk calling the shell tool in the background. */
const backgroundShell = (command: string) =>
  `data: ${JSON.stringify({
    id: 'fixture',
    object: 'chat.completion.chunk',
    model: 'fixture',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'background-call',
              type: 'function',
              function: { name: 'shell', arguments: JSON.stringify({ command, background: true }) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  })}\n\ndata: [DONE]\n\n`;

async function fixture(holdFirst = false, backgroundFirst = false) {
  const requests: unknown[] = [];
  let finish: (() => void) | undefined;
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
      if (backgroundFirst && requests.length === 1) {
        res.end(backgroundShell('sleep 30'));
        return;
      }
      if (holdFirst && requests.length === 1) {
        finish = () => res.end(reply('seed-finished'));
        return;
      }
      res.end(reply('native-restart-answer'));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint');
  const workspace = await createIsolatedWorkspaceLease({
    env: productionEnv,
    prepare: async (root, paths) => {
      await mkdir(join(root, 'work'));
      await mkdir(join(root, 'runtime'), { mode: 0o700 });
      copyBuiltCli(resolve('dist'), join(root, 'direct-dist'));
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
          agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, completionVerification: false },
          shell: { autoApproveMode: 'always' },
          sandbox: { enabled: false },
          memory: { enabled: false },
        }),
      );
    },
  });
  const entry = join(workspace.root, 'direct-dist/src/app/cli.js');
  const runtime = join(workspace.root, 'runtime');
  const child = await workspace.start({
    command: process.execPath,
    args: [entry, '--profile', 'bare', '--control-socket=restart-native'],
    env: { ...productionEnv, XDG_RUNTIME_DIR: runtime },
    cwd: join(workspace.root, 'work'),
    cols: 180,
    rows: 50,
  });
  return {
    workspace,
    child,
    requests,
    entry,
    /** One control request on the session's socket (hello first). */
    async control(method: 'interrupt' | 'status') {
      const socket = connect(listControlAdvertisements(runtime)[0]!.socketPath);
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      try {
        socket.write(JSON.stringify({ v: 1, id: 'hello', method: 'hello' }) + '\n');
        await lines.next();
        socket.write(JSON.stringify({ v: 1, id: method, method }) + '\n');
        return JSON.parse((await lines.next()).value!);
      } finally {
        socket.destroy();
      }
    },
    stopForeground() {
      return this.control('interrupt');
    },
    /** The queue state off screen: legacy draws no paused-queue line. */
    async queuePause() {
      const { result } = await this.control('status');
      return `${result.queueStateKind}/${result.queuePauseReason}`;
    },
    async logs() {
      const files = (await readdir(workspace.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
      return Promise.all(
        files.map(async (file) => ({
          file,
          text: await readFile(join(workspace.paths.conversationsDir, file), 'utf8'),
        })),
      );
    },
    async close() {
      finish?.();
      await workspace.cleanup();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    },
  };
}

it.skipIf(process.platform !== 'linux' || !process.execve)(
  'does not acknowledge stale renders or text typed while a native panel owns input',
  async () => {
    const f = await fixture(false, true);
    try {
      const { child } = f;
      const idle = await child.waitForIdleInput();
      // Nothing typed: no new composer acknowledgement.
      await expect(
        child.waitForComposerValue('', { afterRevision: child.readComposerRevision(), timeoutMs: 250 }),
      ).rejects.toThrow('Timed out');
      // Legacy's Ctrl+G opens the task manager over a running background task.
      await writePtyTextAndSubmit(child, 'start a background task');
      await child.waitForVisibleOutput('native-restart-answer');
      await child.waitForIdleInput({ after: idle });
      await child.write('\u0007');
      await child.waitForVisibleOutput('Manage background tasks');
      const panelRevision = child.readComposerRevision();
      const panelIdle = child.readIdleGeneration();
      await child.write('blocked-input');
      await expect(
        child.waitForComposerValue('blocked-input', { afterRevision: panelRevision, timeoutMs: 250 }),
      ).rejects.toThrow('Timed out');
      // Esc closes the manager; the composer takes input again, still empty.
      await child.write('\u001b');
      await child.waitForIdleInput({ after: panelIdle });
      expect(child.readComposerRevision()).toBe(panelRevision);
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Keyboard shortcuts');
      await writePtyTextAndSubmit(child, '/quit');
      expect((await child.waitForExit()).exitCode).toBe(0);
      // The task's call and the reply after it; nothing typed while the manager owned input was sent.
      expect(f.requests).toHaveLength(2);
      expect(JSON.stringify(f.requests)).not.toContain('blocked-input');
    } finally {
      await f.close();
    }
  },
  60_000,
);

it.skipIf(process.platform !== 'linux' || !process.execve)(
  'retains a real native paused text admission across restart without dispatching it',
  async () => {
    const f = await fixture(true);
    try {
      const child = f.child;
      const { requests } = f;
      await child.waitForIdleInput();
      await writePtyTextAndSubmit(child, 'start native seed turn');
      await expect.poll(() => requests.length).toBe(1);
      // Legacy queues a follow-up with Alt+Enter.
      await child.write('retained plain text');
      await child.waitForComposerValue('retained plain text');
      await child.write('\u001b\r');
      await child.waitForVisibleOutput('│   retained plain text');
      // The public control stop preserves queued work and creates the real manual pause.
      expect(await f.stopForeground()).toMatchObject({ ok: true, result: { accepted: true } });
      await expect.poll(() => f.queuePause(), { timeout: 30_000 }).toBe('paused/manual');
      await child.waitForVisibleOutput('Queue paused: 1 item pending.');
      const before = await f.logs();
      expect(before).toHaveLength(1);
      const factsBefore = before[0]!.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).fact);
      const retained = factsBefore.find(
        (fact) =>
          fact.type === 'queue_submitted' &&
          fact.record.content.some((part: any) => part.text === 'retained plain text'),
      );
      expect(retained).toBeDefined();
      expect(
        factsBefore.filter((fact) => fact.type === 'queue_started' && fact.messageId === retained.record.messageId),
      ).toHaveLength(0);
      const offset = child.getOutput().length;
      await writePtyTextAndSubmit(child, '/restart');
      const preExec = child.readComposerRevision();
      await child.waitForState((state) => state.output.slice(offset).includes('Resumed conversation:'));
      // Fresh post-exec input, not a retained pre-exec clear frame: the new process counts revisions from 1.
      await expect.poll(() => child.readComposerRevision() < preExec, { timeout: 30_000 }).toBe(true);
      await child.waitForComposerValue('', { afterRevision: 0 });
      await expect.poll(() => f.queuePause(), { timeout: 30_000 }).toBe('paused/manual');
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Keyboard shortcuts');
      await writePtyTextAndSubmit(child, '/quit');
      expect((await child.waitForExit()).exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      const after = await f.logs();
      expect(after.map((log) => log.file)).toEqual(before.map((log) => log.file));
      expect(after[0]!.text.startsWith(before[0]!.text)).toBe(true);
      const factsAfter = after[0]!.text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).fact);
      expect(
        factsAfter.filter(
          (fact) => fact.type === 'queue_submitted' && fact.record.messageId === retained.record.messageId,
        ),
      ).toEqual([retained]);
      expect(
        factsAfter.filter(
          (fact) =>
            (fact.type === 'queue_started' || fact.type === 'queue_retracted') &&
            fact.messageId === retained.record.messageId,
        ),
      ).toHaveLength(0);
      expect(factsAfter.filter((fact) => fact.type === 'queue_discarded')).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  90_000,
);

it.skipIf(process.platform !== 'linux' || !process.execve)(
  'reloads real native command code in the same PTY, retains provider history and restarts an empty leaf',
  async () => {
    const f = await fixture();
    try {
      const { child, requests } = f;
      await child.waitForIdleInput();
      const pid = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/)[0]!;
      const identity = async () => {
        const stat = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ');
        return {
          pid: stat[0],
          parent: stat[3],
          tty: stat[6],
          fd0: await readlink(`/proc/${pid}/fd/0`),
          cgroup: await readFile(`/proc/${pid}/cgroup`, 'utf8'),
        };
      };
      const originalIdentity = await identity();
      await writePtyTextAndSubmit(child, 'history-before-native-restart');
      await child.waitForVisibleOutput('native-restart-answer');
      await child.waitForIdleInput();
      const original = (await f.logs())[0]!.file;
      const commands = join(f.workspace.root, 'direct-dist/src/clients/tui/menus/legacy-commands.js');
      await patchCompiledModule(commands, 'Exit the application', 'Changed compiled core B');
      // Running module must still be A; B is only available after real exec.
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Exit the application');
      expect(child.getVisibleOutput()).not.toContain('Changed compiled core B');
      const restart = async () => {
        const offset = child.getOutput().length;
        await writePtyTextAndSubmit(child, '/restart');
        const preExec = child.readComposerRevision();
        await child.waitForState((state) => state.output.slice(offset).includes('Resumed conversation:'));
        // The new process counts composer revisions from 1.
        await expect.poll(() => child.readComposerRevision() < preExec, { timeout: 30_000 }).toBe(true);
        await child.waitForComposerValue('', { afterRevision: 0 });
      };
      await restart();
      expect(await identity()).toEqual(originalIdentity);
      expect((await f.logs()).map((log) => log.file)).toEqual([original]);
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Changed compiled core B');
      await writePtyTextAndSubmit(child, 'history-after-native-restart');
      await expect.poll(() => requests.length).toBe(2);
      expect(JSON.stringify(requests[1])).toContain('history-before-native-restart');
      await child.waitForIdleInput();
      await writePtyTextAndSubmit(child, '/clear');
      await expect.poll(async () => (await f.logs()).length).toBe(2);
      const latest = (await f.logs()).find((log) => log.file !== original)!;
      expect(
        latest.text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line).fact.type),
      ).toEqual(['session_started']);
      await restart();
      const helpOffset = child.getOutput().length;
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForState((state) => state.output.slice(helpOffset).includes('Changed compiled core B'));
      await child.waitForComposerValue('', { afterRevision: 0 });
      expect(await identity()).toEqual(originalIdentity);
      expect((await f.logs()).find((log) => log.file === latest.file)!.text).toBe(latest.text);
      expect(requests).toHaveLength(2);
      await writePtyTextAndSubmit(child, '/quit');
      expect((await child.waitForExit()).exitCode).toBe(0);
    } finally {
      await f.close();
    }
  },
  60_000,
);
