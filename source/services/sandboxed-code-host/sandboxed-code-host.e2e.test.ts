import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import type { HostResult } from './host-types.js';

const require = createRequire(import.meta.url);
const repositoryRoot = process.cwd();

type ChildResult = {
  result: HostResult;
  parentCwdErrorBefore: string | null;
  parentCwdErrorAfter: string | null;
  diagnosticMarker: string;
};

async function runDeletedCwdChild(kind: 'source' | 'built'): Promise<ChildResult> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'term2-sandbox-startup-fixture-'));
  const childPath = join(fixtureRoot, 'deleted-cwd-child.mjs');
  const preloadPath = join(fixtureRoot, 'node-options-preload.cjs');
  const markerPath = join(fixtureRoot, 'node-options-marker');
  const hostModule = pathToFileURL(
    join(
      repositoryRoot,
      kind === 'source'
        ? 'source/services/sandboxed-code-host/sandboxed-code-host.ts'
        : 'dist/services/sandboxed-code-host/sandboxed-code-host.js',
    ),
  ).href;

  await writeFile(
    preloadPath,
    `const { appendFileSync } = require('node:fs');
const { isMainThread } = require('node:worker_threads');
appendFileSync(process.env.TERM2_SANDBOX_DIAGNOSTIC_MARKER, isMainThread ? 'main:' : 'worker:');
appendFileSync(process.env.TERM2_SANDBOX_DIAGNOSTIC_MARKER, process.execArgv.includes('--trace-warnings') ? 'trace\\n' : 'missing\\n');
`,
  );
  await writeFile(
    childPath,
    `(async () => {
  const { mkdir, mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { SandboxedCodeHostImpl } = await import(${JSON.stringify(hostModule)});
  let root;
  let validWorkspace;
  try {
    root = await mkdtemp(join(tmpdir(), 'term2-deleted-cwd-test-'));
    const deletedCwd = join(root, 'deleted-cwd');
    validWorkspace = join(root, 'workspace');
    await Promise.all([mkdir(deletedCwd), mkdir(validWorkspace)]);
    process.chdir(deletedCwd);
    await rm(deletedCwd, { recursive: true, force: true });
    let parentCwdErrorBefore = null;
    try { process.cwd(); } catch (error) { parentCwdErrorBefore = error && error.code || String(error); }
    const result = await new SandboxedCodeHostImpl().run({
      code: 'let escaped = false; try { globalThis.constructor.constructor("return process")(); escaped = true; } catch (_) {} return { ready: true, processType: typeof process, escaped };',
      capabilities: {},
      limits: { timeoutMs: 5000, maxCodeBytes: 65536, maxOutputBytes: 65536, maxConsoleBytes: 65536 },
      subject: 'Script',
    });
    let parentCwdErrorAfter = null;
    try { process.cwd(); } catch (error) { parentCwdErrorAfter = error && error.code || String(error); }
    const diagnosticMarker = await readFile(process.env.TERM2_SANDBOX_DIAGNOSTIC_MARKER, 'utf8');
    process.stdout.write(JSON.stringify({ result, parentCwdErrorBefore, parentCwdErrorAfter, diagnosticMarker }));
  } finally {
    if (validWorkspace) process.chdir(validWorkspace);
    if (root) await rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`,
  );

  const inheritedNodeOptions = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
  const childArgs =
    kind === 'source'
      ? ['--trace-warnings', '--import', require.resolve('tsx/esm'), childPath]
      : ['--trace-warnings', childPath];
  try {
    return await new Promise<ChildResult>((resolve, reject) => {
      const child = spawn(process.execPath, childArgs, {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: `${inheritedNodeOptions}--require=${preloadPath}`,
          TERM2_SANDBOX_DIAGNOSTIC_MARKER: markerPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`deleted-cwd child timed out: ${stderr || stdout}`));
      }, 10_000);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`deleted-cwd child exited ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ChildResult);
        } catch (error) {
          reject(new Error(`deleted-cwd child returned invalid JSON: ${stdout || stderr}`, { cause: error }));
        }
      });
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function expectDeletedCwdWorker(kind: 'source' | 'built') {
  const { result, parentCwdErrorBefore, parentCwdErrorAfter, diagnosticMarker } = await runDeletedCwdChild(kind);

  expect(parentCwdErrorBefore).toBe('ENOENT');
  expect(parentCwdErrorAfter).toBe('ENOENT');
  expect(diagnosticMarker.split('\n')).toEqual(expect.arrayContaining(['main:trace', 'worker:trace']));
  expect(result).toEqual({
    ok: true,
    output: { ready: true, processType: 'undefined', escaped: false },
  });
}

it('starts a real source worker from an actual child module after cwd deletion', async () => {
  await expectDeletedCwdWorker('source');
});

it('starts a real built worker from an actual child module after cwd deletion', async () => {
  const sourcePaths = [
    join(repositoryRoot, 'source/services/sandboxed-code-host/sandbox.ts'),
    join(repositoryRoot, 'source/services/sandboxed-code-host/worker-cwd-preload.cts'),
  ];
  const builtPaths = [
    join(repositoryRoot, 'dist/services/sandboxed-code-host/sandboxed-code-host.js'),
    join(repositoryRoot, 'dist/services/sandboxed-code-host/worker-cwd-preload.cjs'),
  ];
  const [sourceStats, builtStats] = await Promise.all([
    Promise.all(sourcePaths.map((sourcePath) => stat(sourcePath))),
    Promise.all(builtPaths.map((builtPath) => stat(builtPath))),
  ]);
  for (let index = 0; index < sourceStats.length; index++) {
    expect(builtStats[index].mtimeMs, 'run pnpm build before the built sandbox e2e test').toBeGreaterThanOrEqual(
      sourceStats[index].mtimeMs,
    );
  }
  await expectDeletedCwdWorker('built');
});
