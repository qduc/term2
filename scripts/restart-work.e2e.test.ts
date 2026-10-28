import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createConversationLogWriter } from '../source/services/logging/conversation-log-writer.js';
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
const reply = (content: string, tool?: Record<string, unknown>) =>
  `data: ${JSON.stringify({
    id: 'fixture',
    object: 'chat.completion.chunk',
    model: 'fixture',
    choices: [
      {
        index: 0,
        delta: tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content },
        finish_reason: tool ? 'tool_calls' : 'stop',
      },
    ],
  })}\n\ndata: [DONE]\n\n`;

async function rpc(socketPath: string, method: string, params?: unknown): Promise<any> {
  const socket = connect(socketPath);
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  try {
    socket.write(JSON.stringify({ v: 1, id: 'hello', method: 'hello' }) + '\n');
    await lines.next();
    socket.write(JSON.stringify({ v: 1, id: 'call', method, params }) + '\n');
    return JSON.parse((await lines.next()).value!);
  } finally {
    socket.destroy();
  }
}

it
  .skipIf(process.platform !== 'linux' || !process.execve)
  .each(['foreground', 'background', 'paused-text', 'placeholder'] as const)(
  'restart handles real %s ownership without discarding or automatically running retained input',
  async (mode) => {
    let requests = 0;
    let finishForeground: (() => void) | undefined;
    let work = '';
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
        requests++;
        res.setHeader('Content-Type', 'text/event-stream');
        if (mode === 'foreground' && requests === 1) {
          finishForeground = () => res.end(reply('foreground-finished'));
          return;
        }
        if (mode === 'background' && requests === 1) {
          res.end(
            reply('', {
              index: 0,
              id: 'bg-call',
              type: 'function',
              function: {
                name: 'shell',
                arguments: JSON.stringify({
                  command: `'${process.execPath}' -e ${JSON.stringify(
                    `require('node:fs').writeFileSync(${JSON.stringify(
                      join(work, 'owned-child.pid'),
                    )}, String(process.pid)); setTimeout(() => {}, 60000)`,
                  )}`,
                  background: true,
                  timeout_ms: 90000,
                }),
              },
            }),
          );
          return;
        }
        res.end(reply('work-fixture-ready'));
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const seedId = randomUUID();
    const workspace = await createIsolatedWorkspaceLease({
      env: { ...productionEnv, SHELL_AUTO_APPROVE_MODE: 'always', SANDBOX_ENABLED: 'false' },
      prepare: async (root, paths) => {
        work = join(root, 'work');
        await mkdir(work);
        await mkdir(join(root, 'runtime'), { mode: 0o700 });
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
        if (mode === 'paused-text' || mode === 'placeholder') {
          const writer = createConversationLogWriter({
            sessionId: seedId,
            dir: paths.conversationsDir,
            saveLast: () => undefined,
          });
          writer.init({ id: seedId, createdAt: new Date().toISOString(), projectPath: work });
          await writer.close();
          await writeFile(
            join(paths.conversationsDir, `${seedId}.queue.json`),
            JSON.stringify({
              version: 1,
              nextSequence: 2,
              pause: { reason: 'manual' },
              queue: [
                {
                  id: 'retained',
                  text: mode === 'paused-text' ? 'retained plain text' : '[queued non-text user turn]',
                  sequence: 1,
                  submittedAt: new Date().toISOString(),
                },
              ],
            }),
          );
        }
      },
    });
    try {
      const runtimeDir = join(workspace.root, 'runtime');
      const child = await workspace.start({
        command: process.execPath,
        args: [
          resolve('dist/cli.js'),
          '--profile',
          'bare',
          '--control-socket=restart-work',
          ...(mode.startsWith('paused') || mode === 'placeholder' ? ['--resume', seedId] : []),
        ],
        cwd: work,
        env: { ...productionEnv, XDG_RUNTIME_DIR: runtimeDir },
        cols: 180,
        rows: 50,
      });
      if (mode === 'paused-text' || mode === 'placeholder') await child.waitForComposerValue('', { afterRevision: 0 });
      else await child.waitForIdleInput();
      const socketPath = () => listControlAdvertisements(runtimeDir)[0]!.socketPath;
      const pending = async () =>
        JSON.parse(await readFile(join(workspace.paths.conversationsDir, `${seedId}.queue.json`), 'utf8'));
      if (mode === 'foreground' || mode === 'background') {
        const idle = child.readIdleGeneration();
        await writePtyTextAndSubmit(child, 'start owned work');
        await expect.poll(() => requests, { timeout: 5000 }).toBeGreaterThan(0);
        if (mode === 'foreground') {
          await writePtyTextAndSubmit(child, '/restart stop');
          await child.waitForVisibleOutput('Finish or stop the current foreground operation');
          expect(requests).toBe(1);
          finishForeground!();
          await child.waitForIdleInput({ after: idle });
        } else {
          await child.waitForVisibleOutput('work-fixture-ready');
          await child.waitForIdleInput({ after: idle });
          const tasks = async () => (await rpc(socketPath(), 'get', { topic: 'background' })).result.tasks;
          expect((await tasks()).some((task: any) => task.status === 'running')).toBe(true);
          const ownedPid = Number((await readFile(join(work, 'owned-child.pid'), 'utf8')).trim());
          expect(ownedPid).toBeGreaterThan(0);
          await writePtyTextAndSubmit(child, '/restart');
          await child.waitForVisibleOutput('Live background work:');
          expect((await tasks()).some((task: any) => task.status === 'running')).toBe(true);
          expect(ownedPid).toBeGreaterThan(0);
          await writePtyTextAndSubmit(child, '/restart stop');
          await child.waitForVisibleOutput('Resumed conversation:');
          const logs = (await readdir(workspace.paths.conversationsDir)).filter((file) => file.endsWith('.jsonl'));
          const log = await readFile(join(workspace.paths.conversationsDir, logs[0]!), 'utf8');
          const events = log
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line).event);
          expect(events.filter((event) => event.type === 'background_shell_completed')).toEqual([
            expect.objectContaining({ status: 'cancelled' }),
          ]);
        }
      } else {
        const before = await pending();
        const resumedCount = child.getVisibleOutput().split('Resumed conversation:').length;
        expect(JSON.stringify(before)).toContain('retained');
        await writePtyTextAndSubmit(child, '/restart');
        if (mode === 'placeholder') {
          await child.waitForVisibleOutput('non-durable input');
          expect(await pending()).toEqual(before);
        } else {
          await child.waitForState(
            (snapshot) => snapshot.visibleOutput.split('Resumed conversation:').length > resumedCount,
          );
          await expect.poll(() => child.readComposerRevision(), { timeout: 5000 }).toBe(1);
          expect(await pending()).toEqual(before);
          expect(
            JSON.parse(await readFile(join(workspace.paths.conversationsDir, `${seedId}.queue.json`), 'utf8')).queue,
          ).toHaveLength(1);
        }
        expect(requests).toBe(0);
      }
      if (mode === 'background') await expect.poll(() => child.readComposerRevision(), { timeout: 5000 }).toBe(1);
      if (mode === 'foreground' || mode === 'background') {
        await writePtyTextAndSubmit(child, '/quit');
        await child.waitForExit();
      }
    } finally {
      finishForeground?.();
      await workspace.cleanup();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  },
  45_000,
);
