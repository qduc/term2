import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import { createIsolatedWorkspaceLease } from './provider-test-harness.js';

// A built-CLI `--json` run whose stdout is a pipe the reader leaves unread until the child exits
// or one second after the last provider response, whichever comes first. A CLI that exits before
// stdout drains loses everything past the pipe buffer: a benchmark run exited 0 with a ~146 KB
// `final` record cut mid-line and no `run_summary` or `completed`. The final message is far larger
// than the kernel pipe buffer plus the reader's stream buffer.
const FINAL_TEXT = `${'x'.repeat(400_000)}END`;

type PausedRun = {
  readonly exit: { code: number | null; signal: NodeJS.Signals | null };
  readonly served: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Runs the CLI with stdout paused; then `read` drains the pipe, `close` destroys the read end. */
async function runWithPausedStdout(then: 'read' | 'close'): Promise<PausedRun> {
  let served = 0;
  let onServed: () => void = () => {};
  const lastResponse = new Promise<void>((resolve) => (onServed = resolve));
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    for await (const _chunk of req);
    served++;
    const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ id: 'big', choices: [{ delta: { role: 'assistant', content: FINAL_TEXT } }] })}\n\n` +
        `data: ${JSON.stringify({ id: 'big', choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n` +
        'data: [DONE]\n\n',
    );
    onServed();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const lease = await createIsolatedWorkspaceLease({
    prepare: async (root, paths) => {
      await mkdir(join(root, 'project'));
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            retryAttempts: 0,
            maxStreamOutputChars: 1_000_000,
            modelSelection: { model: 'mock-alpha', provider: 'mockprov' },
          },
          providers: [
            {
              name: 'mockprov',
              type: 'openai-compatible',
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: 'fixture',
            },
          ],
          sandbox: { enabled: false },
        }),
      );
    },
  });
  const cwd = join(lease.root, 'project');
  const child = spawn(process.execPath, [testCliPath(join(process.cwd(), 'dist/cli.js')), '--json', 'Say it.'], {
    cwd,
    env: lease.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
  try {
    child.stdout.pause();
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<PausedRun['exit']>((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    const closed = new Promise<void>((resolve) => child.stdout.once('close', () => resolve()));
    await Promise.race([exited, lastResponse]);
    // sleep-ok: a CLI that exits without draining stdout does so while the pipe is unread, and no
    // signal marks a correct CLI blocked on that write; on the parent commit this whole scenario took
    // ~0.6 s, and a race lost to slowness only weakens the red proof, never the pass.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
    if (then === 'close') child.stdout.destroy();
    else {
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stdout.resume();
    }
    const exit = await exited;
    await closed;
    return { exit, served, stdout: Buffer.concat(chunks).toString('utf8'), stderr };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await lease.cleanup();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

it('flushes every --json record to a slow pipe reader before exiting', async () => {
  const { exit, served, stdout, stderr } = await runWithPausedStdout('read');
  expect(exit, stderr).toEqual({ code: 0, signal: null });
  expect(served).toBe(1);
  expect(stdout.length).toBeGreaterThan(2 * FINAL_TEXT.length);
  expect(stdout.endsWith('\n')).toBe(true);
  const events = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, any>);
  expect(events.find((event) => event.type === 'final')).toMatchObject({ finalText: FINAL_TEXT });
  expect(events.at(-2)).toMatchObject({ type: 'run_summary', outcome: 'completed' });
  expect(events.at(-1)).toMatchObject({ type: 'completed', finalText: FINAL_TEXT });
});

// The reader closes the pipe while the CLI waits for its queued tail. The queued writes fail with
// EPIPE; the run's settled exit code must survive that, without an unhandled 'error' crash.
it('keeps the settled exit code when the reader closes the pipe during the drain', async () => {
  const { exit, served, stderr } = await runWithPausedStdout('close');
  expect(served).toBe(1);
  expect(stderr).not.toMatch(/EPIPE|Unhandled 'error' event/);
  expect(exit, stderr).toEqual({ code: 0, signal: null });
});
