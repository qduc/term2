import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startFakeProviderHttpServer, type FakeProviderHttpServer } from './fake-provider-http-server.js';
import {
  createIsolatedWorkspaceLease,
  type IsolatedWorkspaceLease,
  writePtyTextAndSubmit,
  exitInteractive,
} from './provider-test-harness.js';

let server: FakeProviderHttpServer | undefined;
let workspace: IsolatedWorkspaceLease | undefined;
let scenarioOptions: { scenario: 'success' | 'tool-fragments' | 'context-overflow'; protocol: 'chat-completions' };
afterEach(async () => {
  await workspace?.cleanup();
  workspace = undefined;
  await server?.close();
  server = undefined;
});
const setup = async (
  scenario: 'success' | 'tool-fragments' | 'context-overflow',
  agent: Record<string, unknown> = {},
) => {
  scenarioOptions = { scenario, protocol: 'chat-completions' };
  server = await startFakeProviderHttpServer(scenarioOptions);
  workspace = await createIsolatedWorkspaceLease({
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: { modelSelection: { model: 'fixture', provider: 'fixture-provider' }, ...agent },
          app: { liteMode: true },
          providers: [
            {
              id: 'fixture-provider',
              name: 'fixture-provider',
              type: 'openai-compatible',
              baseUrl: server!.baseUrl,
              apiKey: 'fixture-key',
            },
          ],
        }),
      );
    },
  });
  return workspace;
};

it('completes ordinary useful work with fresh safety defaults and keeps a resumable session', async () => {
  const lease = await setup('success');
  const result = await lease.runCli({
    cwd: process.cwd(),
    args: ['fixture useful request', '--provider', 'fixture-provider', '--model', 'fixture'],
    deadlineMs: 15000,
  });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toBe('hello\n');
  expect(server!.requests).toHaveLength(1);
  const logs = (await readdir(lease.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
  expect(logs).toHaveLength(1);
  const data = await readFile(join(lease.paths.conversationsDir, logs[0]!), 'utf8');
  expect(data).toContain('fixture useful request');
  expect(data).toContain('hello');
});

it('admits input beyond the old universal ceiling when known capacity permits', async () => {
  const lease = await setup('success');
  const result = await lease.runCli({
    cwd: process.cwd(),
    args: [...Array(5).fill('x'.repeat(100000)), '--provider', 'fixture-provider', '--model', 'gpt-5.6-luna'],
    deadlineMs: 15000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(server!.requests).toHaveLength(1);
  expect(server!.requests[0]!.body).toMatchObject({ max_tokens: 32000 });
});

it('pauses before dispatch on a known small model with fresh defaults', async () => {
  const lease = await setup('success');
  const result = await lease.runCli({
    cwd: process.cwd(),
    args: ['x'.repeat(40000), '--provider', 'fixture-provider', '--model', 'gpt-4', '--json'],
    deadlineMs: 15000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(2);
  expect(result.stdout).toContain('context_paused');
  expect(result.stdout).toContain('--resume non-interactive-');
  expect(server!.requests).toHaveLength(0);
});

it.each([undefined, 'warn'] as const)(
  'enforces an explicit smaller input ceiling with escalation=%s and retains a locator',
  async (escalation) => {
    const lease = await setup('success', {
      maxRequestInputTokens: 96000,
      ...(escalation ? { runBudget: { escalation } } : {}),
    });
    const result = await lease.runCli({
      cwd: process.cwd(),
      args: [...Array(5).fill('x'.repeat(100000)), '--provider', 'fixture-provider', '--model', 'fixture', '--json'],
      deadlineMs: 15000,
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(2);
    expect(result.stdout).toContain('context_paused');
    expect(result.stdout).toContain('request_input_limit');
    expect(result.stdout).toContain('--resume non-interactive-');
    expect(server!.requests).toHaveLength(0);
    const logs = (await readdir(lease.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
    expect(logs).toHaveLength(1);
    expect(await readFile(join(lease.paths.conversationsDir, logs[0]!), 'utf8')).toContain('x'.repeat(1000));
  },
);

it('parks an unattended critical budget without auto-granting and retains completed tool evidence', async () => {
  const lease = await setup('tool-fragments', { runBudget: { turnBackstop: 1 } });
  const result = await lease.runCli({
    cwd: process.cwd(),
    args: ['fixture budget work', '--provider', 'fixture-provider', '--model', 'fixture', '--json', '--auto-approve'],
    deadlineMs: 15000,
  });
  expect(result.timedOut).toBe(false);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(2);
  expect(result.stdout).toContain('run_budget_paused');
  expect(result.stdout).toContain('--resume non-interactive-');
  expect(server!.requests).toHaveLength(1);
  const logs = (await readdir(lease.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
  expect(logs).toHaveLength(1);
  const log = await readFile(join(lease.paths.conversationsDir, logs[0]!), 'utf8');
  expect(log).toContain('call_fake');
  expect(log).toContain('fixture budget work');
  scenarioOptions.scenario = 'success';
  const sessionId = logs[0]!.replace(/\.jsonl$/, '');
  const resumed = await lease.start({ cwd: process.cwd(), args: ['--resume', sessionId, '--fork'] });
  await resumed.waitForVisibleOutput('Resumed conversation:');
  const idle = await resumed.waitForIdleInput();
  await writePtyTextAndSubmit(resumed, 'Verify retained tool evidence and finish safely.');
  await resumed.waitForVisibleOutput('hello');
  await resumed.waitForIdleInput({ after: idle });
  await exitInteractive(resumed);
  expect(server!.requests).toHaveLength(2);
  const resumedInput = JSON.stringify(server!.requests[1]!.body);
  expect(resumedInput).toContain('fixture budget work');
  expect(resumedInput).toContain('call_fake');
  expect(resumedInput).toContain('Unknown tool: fixture');
});

it('retains unknown-model work after structured provider overflow without retrying', async () => {
  const lease = await setup('context-overflow', { retryAttempts: 2 });
  const result = await lease.runCli({
    cwd: process.cwd(),
    args: ['retain this request', '--provider', 'fixture-provider', '--model', 'fixture', '--json'],
    deadlineMs: 15000,
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(2);
  expect(result.stdout).toContain('context_paused');
  expect(result.stdout).toContain('provider_context_overflow');
  expect(result.stdout).toContain('--resume non-interactive-');
  expect(server!.requests).toHaveLength(1);
  const logs = (await readdir(lease.paths.conversationsDir)).filter((name) => name.endsWith('.jsonl'));
  expect(await readFile(join(lease.paths.conversationsDir, logs[0]!), 'utf8')).toContain('retain this request');
});
