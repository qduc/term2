/** Native counterparts to legacy-storage restart probes. No legacy facts or sidecars are seeded. */
import { createServer } from 'node:http';
import { cp, mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { listControlAdvertisements } from '../source/services/control-socket/control-socket.js';
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

async function fixture(holdFirst = false) {
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
      await cp(resolve('rewrite/dist'), join(root, 'direct-dist'), { recursive: true });
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
  const entry = join(workspace.root, 'direct-dist/rewrite/src/app/cli.js');
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
    async stopForeground() {
      const socket = connect(listControlAdvertisements(runtime)[0]!.socketPath);
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      try {
        socket.write(JSON.stringify({ v: 1, id: 'hello', method: 'hello' }) + '\n');
        await lines.next();
        socket.write(JSON.stringify({ v: 1, id: 'stop', method: 'interrupt' }) + '\n');
        return JSON.parse((await lines.next()).value!);
      } finally {
        socket.destroy();
      }
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

it.skipIf(process.platform !== 'linux' || !process.execve || !process.env.TERM2_TEST_CLI)(
  'does not acknowledge stale renders or text typed while a native panel owns input',
  async () => {
    const f = await fixture();
    try {
      const { child } = f;
      await child.waitForIdleInput();
      const offset = child.getOutput().length;
      await expect(child.waitForComposerValue('', { afterRevision: offset + 1, timeoutMs: 250 })).rejects.toThrow(
        'Timed out',
      );
      // Legacy has no /tasks command; Ctrl+G opens the task manager.
      await child.write('\u0007');
      await child.waitForVisibleOutput('No background tasks.');
      const panelOffset = child.getOutput().length;
      await child.write('blocked-input');
      await expect(
        child.waitForComposerValue('blocked-input', { afterRevision: panelOffset, timeoutMs: 250 }),
      ).rejects.toThrow('Timed out');
      await child.write('\u001b');
      await child.waitForComposerValue('', { afterRevision: panelOffset });
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Keyboard shortcuts');
      await writePtyTextAndSubmit(child, '/quit');
      expect((await child.waitForExit()).exitCode).toBe(0);
      expect(f.requests).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  20_000,
);

it.skipIf(process.platform !== 'linux' || !process.execve || !process.env.TERM2_TEST_CLI)(
  'retains a real native paused text admission across restart without dispatching it',
  async () => {
    const f = await fixture(true);
    try {
      const child = f.child;
      const { requests } = f;
      await child.waitForIdleInput();
      await writePtyTextAndSubmit(child, 'start native seed turn');
      await expect.poll(() => requests.length).toBe(1);
      // Legacy has no /followup command; Alt+Enter submits a follow-up during a turn.
      {
        const afterRevision = child.readComposerRevision();
        await child.write('retained plain text');
        await child.waitForComposerValue('retained plain text', { afterRevision });
        await child.write('\u001b\r');
      }
      await child.waitForVisibleOutput('Queued 1 (queued): retained plain text');
      // The public control stop preserves queued work and creates the real manual pause.
      expect(await f.stopForeground()).toMatchObject({ ok: true, result: { accepted: true } });
      await child.waitForVisibleOutput('Queue: paused · manual');
      await child.waitForComposerValue('');
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
      await child.waitForState((state) => state.output.slice(offset).includes('Resumed conversation:'));
      // Fresh post-exec input, not a retained pre-exec clear frame.
      await child.waitForComposerValue('', { afterRevision: child.getOutput().lastIndexOf('Resumed conversation:') });
      await child.waitForState((state) =>
        state.output.slice(state.output.lastIndexOf('Resumed conversation:')).includes('Queue: paused · manual'),
      );
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
  45_000,
);

it.skipIf(process.platform !== 'linux' || !process.execve || !process.env.TERM2_TEST_CLI)(
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
      const commands = join(f.workspace.root, 'direct-dist/rewrite/src/app/direct-launch-tui-commands.js');
      const code = await readFile(commands, 'utf8');
      expect(code).toContain('Exit the application');
      await writeFile(commands, code.replace('Exit the application', 'Changed compiled core B'));
      // Running module must still be A; B is only available after real exec.
      await writePtyTextAndSubmit(child, '/help');
      await child.waitForVisibleOutput('Exit the application');
      expect(child.getVisibleOutput()).not.toContain('Changed compiled core B');
      const restart = async () => {
        const offset = child.getOutput().length;
        await writePtyTextAndSubmit(child, '/restart');
        await child.waitForState((state) => state.output.slice(offset).includes('Resumed conversation:'));
        await child.waitForComposerValue('', { afterRevision: child.getOutput().lastIndexOf('Resumed conversation:') });
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
      await child.waitForComposerValue('', { afterRevision: helpOffset });
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
