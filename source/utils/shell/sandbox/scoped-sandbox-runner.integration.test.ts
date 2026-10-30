import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createScopedSandboxNetworkAccess } from './scoped-sandbox-network-access.js';
import { ScopedSandboxRunner } from './scoped-sandbox-runner.js';
import { SandboxNetworkApprovalCoordinator } from './sandbox-network-approval-coordinator.js';

// The CI integration lane builds dist before running this test. The real helper
// must be the shipped JavaScript entry, not a test-only TypeScript loader.
describe('scoped sandbox helpers', () => {
  it('keeps the leased child paused until all graph approvals settle', async () => {
    const answers: Array<(answer: 'allow-once' | 'deny') => void> = [];
    const completions: Array<Promise<import('./scoped-sandbox-network-access.js').SandboxNetworkCompletion>> = [];
    const scope = createScopedSandboxNetworkAccess({
      workspaceRoot: process.cwd(),
      requestApproval: (_request, completion) => {
        completions.push(completion);
        return new Promise((resolve) => {
          answers.push(resolve);
        });
      },
    });
    const first = scope.request({ host: 'first.example' });
    const second = scope.request({ host: 'second.example' });
    const transitions: string[] = [];
    scope.registerPauseController({
      pause: () => {
        transitions.push('pause');
      },
      resume: () => {
        transitions.push('resume');
      },
    });
    await vi.waitFor(() => expect(transitions).toEqual(['pause']));
    answers[0]!('allow-once');
    expect(await first).toBe(true);
    expect(transitions).toEqual(['pause']);
    answers[1]!('deny');
    expect(await second).toBe(false);
    await vi.waitFor(() => expect(transitions).toEqual(['pause', 'resume']));
    expect(await Promise.all(completions)).toEqual([
      { kind: 'applied', allowed: true },
      { kind: 'applied', allowed: false },
    ]);
    scope.dispose();
  });
  it('cancels only the original queued or active approval', async () => {
    const coordinator = new SandboxNetworkApprovalCoordinator();
    const first = { host: 'first.example' };
    const second = { host: 'second.example' };
    const a = coordinator.request(first);
    const b = coordinator.request(second);
    expect(coordinator.cancel({ host: 'first.example' })).toBe(false);
    expect(coordinator.cancel(first)).toBe(true);
    expect(await a).toBe('deny');
    expect(coordinator.getSnapshot().activeRequest).toBe(second);
    coordinator.resolve(second, 'allow-once');
    expect(await b).toBe('allow-once');
    coordinator.dispose();
  });
  it('fails closed and removes its owned temp tree when the initialized helper is killed', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'term2-helper-test-'));
    const marker = join(fixture, 'temp-path');
    const helper = join(fixture, 'helper.mjs');
    const runtime = import.meta.resolve('@anthropic-ai/sandbox-runtime');
    writeFileSync(
      helper,
      `import { SandboxManager as m } from ${JSON.stringify(runtime)};
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
process.on('message', async x => { if (x.type !== 'wrap') return; writeFileSync(${JSON.stringify(
        marker,
      )}, tmpdir()); await m.initialize(x.config, async () => false); process.send({version:1,type:'bridges',id:x.id,http:m.getLinuxHttpSocketPath(),socks:m.getLinuxSocksSocketPath()}); const command = await m.wrapWithSandbox(x.command); process.send({version:1,type:'result',id:x.id,result:{command,diagnostics:[]}}, () => setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20)); });`,
    );
    let lost = false;
    const scope = createScopedSandboxNetworkAccess({ workspaceRoot: fixture, requestApproval: async () => false });
    const runner = new ScopedSandboxRunner(
      scope,
      () => {
        lost = true;
      },
      async () => {},
      pathToFileURL(helper),
    );
    try {
      await runner.wrap('true', {
        cwd: fixture,
        config: {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
        },
      });
      const ownedTemp = readFileSync(marker, 'utf8');
      await vi.waitFor(() => expect(lost).toBe(true), { timeout: 5000 });
      expect(existsSync(ownedTemp)).toBe(false);
      expect(await scope.request({ host: 'blocked.example' })).toBe(false);
    } finally {
      await runner.dispose();
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 20_000);
  it('routes simultaneous sandboxed network requests to their owning graph', async () => {
    const approvals: string[] = [];
    const entry = new URL('../../../../dist/utils/shell/sandbox/scoped-sandbox-helper.js', import.meta.url);
    const make = (owner: string) => {
      const scope = createScopedSandboxNetworkAccess({
        workspaceRoot: process.cwd(),
        requestApproval: async ({ host }) => {
          approvals.push(`${owner}:${host}`);
          return 'deny';
        },
      });
      const runner = new ScopedSandboxRunner(
        scope,
        () => {},
        async () => {},
        entry,
      );
      return { runner, scope };
    };
    const a = make('A');
    const b = make('B');
    const config = {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
    };
    try {
      expect(fileURLToPath(entry)).toContain('/dist/');
      expect((await a.runner.availability()).type).toBe('available');
      expect((await b.runner.availability()).type).toBe('available');
      const run = async (graph: typeof a, host: string) => {
        const release = await graph.runner.acquire();
        try {
          const wrapped = await graph.runner.wrap(
            `curl --noproxy '' --silent --show-error --max-time 8 https://${host}/`,
            { cwd: process.cwd(), config },
          );
          const outcome = await promisify(exec)(wrapped.command, { timeout: 12000 }).then(
            () => '',
            (error) => String(error.stderr),
          );
          expect(outcome).toMatch(/403|blocked/i);
        } finally {
          await graph.runner.cleanupAfterCommand();
          release();
        }
      };
      await Promise.all([run(a, 'a.example'), run(b, 'b.example')]);
      expect(approvals.sort()).toEqual(['A:a.example', 'B:b.example']);
    } finally {
      await Promise.all([a.runner.dispose(), b.runner.dispose()]);
    }
  }, 30_000);
});
