import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repositoryRoot = process.cwd();

type ChildResult = {
  result: unknown;
  initialCwd: string;
  workspaceCwd: string;
  deletedCwd: string;
  parentCwdBefore: string | null;
  parentCwdAfter: string | null;
  parentCwdErrorBefore: string | null;
  parentCwdErrorAfter: string | null;
  diagnosticMarker: string;
};

type WorkerKind = 'sandbox' | 'index';
type CwdState = 'healthy' | 'deleted';

async function runWorkerChild(
  kind: 'source' | 'built',
  workerKind: WorkerKind,
  cwdState: CwdState,
  cachedCwd = false,
): Promise<ChildResult> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'term2-sandbox-startup-fixture-'));
  const childPath = join(fixtureRoot, 'worker-bootstrap-child.mjs');
  const preloadPath = join(fixtureRoot, 'node-options-preload.cjs');
  const markerPath = join(fixtureRoot, 'node-options-marker');
  const indexModule = pathToFileURL(
    join(
      repositoryRoot,
      kind === 'source'
        ? 'source/services/conversation/session-index/session-index-worker-client.ts'
        : 'dist/services/conversation/session-index/session-index-worker-client.js',
    ),
  ).href;
  const hostModule = pathToFileURL(
    join(
      repositoryRoot,
      kind === 'source'
        ? 'source/services/sandboxed-code-host/sandboxed-code-host.ts'
        : 'dist/services/sandboxed-code-host/sandboxed-code-host.js',
    ),
  ).href;
  const workerImport =
    workerKind === 'sandbox'
      ? `const { SandboxedCodeHostImpl } = await import(${JSON.stringify(hostModule)});`
      : `const { SessionIndexWorkerClient } = await import(${JSON.stringify(indexModule)});`;
  const workerRun =
    workerKind === 'sandbox'
      ? `await new SandboxedCodeHostImpl().run({
      code: 'let escaped = false; try { globalThis.constructor.constructor("return process")(); escaped = true; } catch (_) {} return { ready: true, processType: typeof process, escaped };',
      capabilities: {},
      limits: { timeoutMs: 5000, maxCodeBytes: 65536, maxOutputBytes: 65536, maxConsoleBytes: 65536 },
      subject: 'Script',
    })`
      : `await (async () => {
      const client = new SessionIndexWorkerClient(join(root, 'index.sqlite'), validWorkspace);
      try {
        return { ok: true, output: await client.probe() };
      } catch (error) {
        return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } };
      } finally {
        await client.close();
      }
    })()`;

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
  const { mkdir, mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  ${workerImport}
  const initialCwd = process.cwd();
  let root;
  let validWorkspace;
  try {
    root = await mkdtemp(join(tmpdir(), 'term2-deleted-cwd-test-'));
    const deletedCwd = join(root, 'deleted-cwd');
    validWorkspace = join(root, 'workspace');
    await Promise.all([mkdir(deletedCwd), mkdir(validWorkspace)]);
    if (${JSON.stringify(cwdState === 'deleted')}) process.chdir(deletedCwd);
    if (${JSON.stringify(cachedCwd)}) process.cwd();
    if (${JSON.stringify(cwdState === 'deleted')}) {
      await rm(deletedCwd, { recursive: true, force: true });
    }
    let parentCwdBefore = null;
    let parentCwdErrorBefore = null;
    try {
      parentCwdBefore = process.cwd();
    } catch (error) {
      parentCwdErrorBefore = error && error.code || String(error);
    }
    const result = ${workerRun};
    let parentCwdAfter = null;
    let parentCwdErrorAfter = null;
    try {
      parentCwdAfter = process.cwd();
    } catch (error) {
      parentCwdErrorAfter = error && error.code || String(error);
    }
    const diagnosticMarker = await readFile(process.env.TERM2_SANDBOX_DIAGNOSTIC_MARKER, 'utf8');
    process.stdout.write(JSON.stringify({
      result,
      initialCwd,
      workspaceCwd: validWorkspace,
      deletedCwd,
      parentCwdBefore,
      parentCwdAfter,
      parentCwdErrorBefore,
      parentCwdErrorAfter,
      diagnosticMarker,
    }));
  } finally {
    if (validWorkspace) process.chdir(validWorkspace);
    if (root) await rm(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
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
        reject(new Error(`worker bootstrap child timed out: ${stderr || stdout}`));
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
          reject(new Error(`worker bootstrap child exited ${code}: ${stderr || stdout}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ChildResult);
        } catch (error) {
          reject(new Error(`worker bootstrap child returned invalid JSON: ${stdout || stderr}`, { cause: error }));
        }
      });
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function expectBootstrapDiagnostics(diagnosticMarker: string) {
  expect(diagnosticMarker.split('\n')).toEqual(expect.arrayContaining(['main:trace', 'worker:trace']));
}

async function expectSandboxWorker(kind: 'source' | 'built', cwdState: CwdState, cachedCwd = false) {
  const child = await runWorkerChild(kind, 'sandbox', cwdState, cachedCwd);
  const expectedParentCwd = cwdState === 'healthy' ? child.initialCwd : cachedCwd ? child.deletedCwd : null;

  expect(child.parentCwdBefore).toBe(expectedParentCwd);
  expect(child.parentCwdAfter).toBe(expectedParentCwd);
  expect(child.parentCwdErrorBefore).toBe(cwdState === 'deleted' && !cachedCwd ? 'ENOENT' : null);
  expect(child.parentCwdErrorAfter).toBe(cwdState === 'deleted' && !cachedCwd ? 'ENOENT' : null);
  expectBootstrapDiagnostics(child.diagnosticMarker);
  expect(child.result).toEqual({
    ok: true,
    output: { ready: true, processType: 'undefined', escaped: false },
  });
}

async function expectIndexWorker(kind: 'source' | 'built', cwdState: CwdState, cachedCwd = false) {
  const child = await runWorkerChild(kind, 'index', cwdState, cachedCwd);
  const expectedParentCwd = cwdState === 'healthy' ? child.initialCwd : cachedCwd ? child.deletedCwd : null;

  expect(child.parentCwdBefore).toBe(expectedParentCwd);
  expect(child.parentCwdAfter).toBe(expectedParentCwd);
  expect(child.parentCwdErrorBefore).toBe(cwdState === 'deleted' && !cachedCwd ? 'ENOENT' : null);
  expect(child.parentCwdErrorAfter).toBe(cwdState === 'deleted' && !cachedCwd ? 'ENOENT' : null);
  expectBootstrapDiagnostics(child.diagnosticMarker);
  expect(child.result).toEqual({ ok: true, output: { ok: true } });
}

it.each(['source', 'built'] as const)('preserves a healthy cwd for a real %s worker', async (kind) => {
  await expectSandboxWorker(kind, 'healthy');
});

it.each(['source', 'built'] as const)('preserves a healthy cwd for a real %s index worker', async (kind) => {
  await expectIndexWorker(kind, 'healthy');
});

it.each(['source', 'built'] as const)('starts a real %s index worker after cwd deletion', async (kind) => {
  await expectIndexWorker(kind, 'deleted');
});

it.each(['source', 'built'] as const)('starts a real %s worker after a cached cwd is deleted', async (kind) => {
  await expectSandboxWorker(kind, 'deleted', true);
});

it.each(['source', 'built'] as const)('starts a real %s index worker after a cached cwd is deleted', async (kind) => {
  await expectIndexWorker(kind, 'deleted', true);
});

it('starts a real source worker from an actual child module after cwd deletion', async () => {
  await expectSandboxWorker('source', 'deleted');
});

it('starts a real built worker from an actual child module after cwd deletion', async () => {
  const sourcePaths = [
    join(repositoryRoot, 'source/services/sandboxed-code-host/sandbox.ts'),
    join(repositoryRoot, 'source/utils/worker-bootstrap.ts'),
    join(repositoryRoot, 'source/utils/worker-cwd-preload.cts'),
    join(repositoryRoot, 'source/services/conversation/session-index/session-index-worker-client.ts'),
  ];
  const builtPaths = [
    join(repositoryRoot, 'dist/services/sandboxed-code-host/sandboxed-code-host.js'),
    join(repositoryRoot, 'dist/utils/worker-bootstrap.js'),
    join(repositoryRoot, 'dist/utils/worker-cwd-preload.cjs'),
    join(repositoryRoot, 'dist/services/conversation/session-index/session-index-worker-client.js'),
  ];
  const [sourceStats, builtStats] = await Promise.all([
    Promise.all(sourcePaths.map((sourcePath) => stat(sourcePath))),
    Promise.all(builtPaths.map((builtPath) => stat(builtPath))),
  ]);
  for (let index = 0; index < sourceStats.length; index++) {
    expect(builtStats[index].mtimeMs, 'run pnpm build before the worker bootstrap e2e test').toBeGreaterThanOrEqual(
      sourceStats[index].mtimeMs,
    );
  }
  await expectSandboxWorker('built', 'deleted');
});
