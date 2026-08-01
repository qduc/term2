import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface BlackBoxRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runIsolatedCli(options: {
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  deadlineMs?: number;
}): Promise<BlackBoxRun> {
  const root = await mkdtemp(join(tmpdir(), 'term2-provider-blackbox-'));
  const stdoutPath = join(root, 'stdout.txt');
  const stderrPath = join(root, 'stderr.txt');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|PASSWORD|SECRET)/i.test(key)),
  );
  Object.assign(env, options.env, {
    HOME: root,
    CODEX_HOME: join(root, 'codex'),
    TERM2_CONVERSATIONS_DIR: join(root, 'conversations'),
    TERM2_LOG_DIR: join(root, 'logs'),
    TERM2_CACHE_DIR: join(root, 'cache'),
  });
  const child = spawn(process.execPath, [join(options.cwd, 'dist/cli.js'), ...options.args], {
    cwd: options.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (await import('node:fs')).createWriteStream(stdoutPath);
  const err = (await import('node:fs')).createWriteStream(stderrPath);
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 500);
  }, options.deadlineMs ?? 20_000);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal })),
  );
  clearTimeout(timer);
  await Promise.all([
    new Promise<void>((resolve) => out.once('close', resolve)),
    new Promise<void>((resolve) => err.once('close', resolve)),
  ]);
  const output = {
    ...result,
    timedOut,
    stdout: await readFile(stdoutPath, 'utf8'),
    stderr: await readFile(stderrPath, 'utf8'),
  };
  await rm(root, { recursive: true, force: true });
  return output;
}

export function collectStream<T>(stream: AsyncIterable<T>): Promise<T[]> {
  return (async () => {
    const result: T[] = [];
    for await (const item of stream) result.push(item);
    return result;
  })();
}
