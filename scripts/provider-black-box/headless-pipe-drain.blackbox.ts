import { execFileSync, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
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

// A pre-run error (an unknown --provider, exit 1) before any run starts has no run-level signal handlers. Its message is far larger
// than the pipe buffer and the reader never reads, so the exit stays in the stdout/stderr drain.
// A SIGINT/SIGTERM then must exit with the decided code, not die by signal (130/143).
const PIPE_BUFFER_BYTES = 65_536;

/** Bytes the process has written so far (`/proc/<pid>/io` wchar), or 0 if unreadable. */
async function bytesWritten(pid: number): Promise<number> {
  try {
    const io = await readFile(`/proc/${pid}/io`, 'utf8');
    return Number(/^wchar:\s*(\d+)/m.exec(io)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

// Readiness reads Linux /proc/<pid>/io.
it.skipIf(!existsSync('/proc/self/io')).each(['SIGINT', 'SIGTERM'] as const)(
  'exits with the decided code on %s during a pre-run drain of an unread stderr',
  async (signal) => {
    const lease = await createIsolatedWorkspaceLease({
      prepare: async (root) => {
        await mkdir(join(root, 'project'));
      },
    });
    // A real pipe (mkfifo), not the socketpair `stdio: 'pipe'` makes: that holds more than the
    // 100 KB message, so the CLI would never block. The read end is held open and never read.
    const fifo = join(lease.root, 'stderr.fifo');
    execFileSync('mkfifo', [fifo]);
    const readEnd = await open(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    const writeEnd = await open(fifo, constants.O_WRONLY);
    const huge = 'U'.repeat(100_000);
    const child = spawn(
      process.execPath,
      [testCliPath(join(process.cwd(), 'dist/cli.js')), '--json', '--provider', huge, 'hi'],
      { cwd: join(lease.root, 'project'), env: lease.env, stdio: ['ignore', 'ignore', writeEnd.fd] },
    );
    await writeEnd.close();
    const deadline = setTimeout(() => child.kill('SIGKILL'), 45_000);
    try {
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, sig) => resolve({ code, signal: sig })),
      );
      // Readiness: the stderr pipe is full once the CLI has written a pipe buffer's worth, so the
      // rest of the message, and the exit, wait on the unread reader.
      await expect
        .poll(() => bytesWritten(child.pid!), { interval: 25, timeout: 20_000 })
        .toBeGreaterThanOrEqual(PIPE_BUFFER_BYTES);
      expect(child.exitCode, 'CLI exited before the drain was pending').toBeNull();
      child.kill(signal);
      expect(await exited).toEqual({ code: 1, signal: null });
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await readEnd.close();
      await lease.cleanup();
    }
  },
);
