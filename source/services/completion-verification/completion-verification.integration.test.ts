import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import envPaths from 'env-paths';
const git = promisify(execFile);
import { CompletionVerificationOrchestrator, type VerificationOperations } from './orchestrator.js';
import { VerificationStore } from './store.js';
import {
  DEFAULT_BUDGETS,
  POLICY_VERSION,
  type CompletionProposal,
  type GateDecision,
  type VerificationRequest,
} from './contracts.js';
import { readVerificationFile, snapshotWorkspace, verificationGit } from './workspace.js';
import { createIndependentVerifier, runQuickCheck } from './verifier.js';
import { RootCompletionBoundary } from './root-boundary.js';
import { createVerificationGate } from './gate.js';
import { createVerifiedGoalStopPolicy } from './goal-stop-policy.js';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import { formatRecordedGoalCheck } from '../conversation/durable-goal-stop-check.js';
import type { DurableGoal } from '../logging/conversation-log-events.js';
import type { StreamedModelTurn, StreamedModelTurnRequest } from '../../contracts/streamed-model-turn.js';
import { AgentClient } from '../../lib/agent-client.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import {
  createMockSettings,
  createMockLogger,
  createMockExecutionContext,
  createSessionContextService,
  registerTestProvider,
} from '../subagents/test-helpers/subagent-manager-fixtures.js';

let root: string;
let store: VerificationStore;
let proposal: CompletionProposal;
const decision = (action: GateDecision['action']): GateDecision => ({
  action,
  policyVersion: POLICY_VERSION,
  reason: 'Fixture decision',
});
const report = (request: VerificationRequest, outcome = 'PASS', evidence = 'Observed acceptance criteria') => ({
  outcome,
  evidence,
  checked: ['Current repository artifact'],
  limitations: ['Fixture provider'],
  verifierVersion: 'fixture-v1',
  attemptId: request.attemptId,
  revision: request.revision,
});
function operations(overrides: Partial<VerificationOperations> = {}): VerificationOperations {
  return {
    gate: async () => decision('independent_verify'),
    verify: async (request) => report(request),
    quickCheck: async (input, request) => report(request),
    currentRevision: async () => (await snapshotWorkspace(root)).revision,
    ...overrides,
  };
}
const budgets = { ...DEFAULT_BUDGETS, gateTimeoutMs: 500, operationTimeoutMs: 5000 };
async function revised(): Promise<CompletionProposal> {
  await writeFile(path.join(root, 'README.md'), `Revision ${Math.random()}\n`);
  return { ...proposal, ...(await snapshotWorkspace(root)) };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'completion-verification-'));
  await git('git', ['init', '--quiet', root]);
  await writeFile(path.join(root, 'README.md'), 'Original\n');
  await git('git', ['-C', root, 'add', 'README.md']);
  await git('git', [
    '-C',
    root,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ]);
  proposal = {
    taskId: 'task',
    goal: 'Update README',
    criteria: 'README contains Updated',
    evidence: 'WORKER_PRIVATE_SENTINEL',
    ...(await snapshotWorkspace(root)),
  };
  proposal = await revised();
  // State lives outside the repository snapshot, just as it does in production.
  store = new VerificationStore(path.join(root, '.git', 'verification.sqlite'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  store?.close();
  await rm(root, { recursive: true, force: true });
});

describe('completion verification through repository and persisted task boundaries', () => {
  it('records policy-authorized skip and survives reopening without redispatch', async () => {
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({ gate: async () => decision('skip') }),
      budgets,
    );
    expect((await orchestrator.propose(proposal)).action).toBe('complete');
    store.close();
    store = new VerificationStore(path.join(root, '.git', 'verification.sqlite'));
    const resumed = new CompletionVerificationOrchestrator(
      store,
      operations({
        gate: async () => {
          throw new Error('Must not dispatch');
        },
      }),
      budgets,
    );
    const result = await resumed.propose(proposal);
    expect(result.action).toBe('complete');
    expect(store.read('task')?.decision?.action).toBe('skip');
    expect(store.read('task')?.gates).toBe(1);
    expect(store.read('task')?.verifications).toBe(0);
  });

  it('cannot bypass mandatory verification with a skip recommendation', async () => {
    await writeFile(path.join(root, 'auth.ts'), 'export const allow = true;\n');
    proposal = { ...proposal, ...(await snapshotWorkspace(root)) };
    let calls = 0;
    const result = await new CompletionVerificationOrchestrator(
      store,
      operations({
        gate: async () => decision('skip'),
        verify: async (request) => {
          calls++;
          return report(request, 'FAIL', 'Unauthorized requests are allowed');
        },
      }),
      budgets,
    ).propose(proposal);
    expect(result.action).toBe('repair');
    expect(calls).toBe(1);
    expect(store.read('task')?.decision?.action).toBe('independent_verify');
  });

  it.each(['INCONCLUSIVE', 'ERROR', 'TIMEOUT', 'BOGUS'])(
    'never completes on %s and freezes terminal state',
    async (outcome) => {
      const orchestrator = new CompletionVerificationOrchestrator(
        store,
        operations({ verify: async (request) => report(request, outcome) }),
        budgets,
      );
      expect((await orchestrator.propose(proposal)).action).toBe('blocked');
      const previous = store.read('task')!;
      expect(previous.state).toBe('BLOCKED');
      expect(
        store.write({ ...previous, generation: previous.generation + 1, state: 'COMPLETED' }, previous.generation),
      ).toBe(false);
      expect((await orchestrator.propose(await revised())).action).toBe('blocked');
    },
  );

  it('uses the conservative fallback for malformed or unknown-version gate output', async () => {
    let calls = 0;
    const result = await new CompletionVerificationOrchestrator(
      store,
      operations({
        gate: async () => ({ action: 'skip', policyVersion: 'unknown', confidence: NaN }),
        verify: async (request) => {
          calls++;
          return report(request);
        },
      }),
      budgets,
    ).propose(proposal);
    expect(result.action).toBe('complete');
    expect(calls).toBe(1);
    expect(store.read('task')?.decision?.reason).toContain('fallback');
  });

  it('samples skipped tasks for audit and preserves the model recommendation separately', async () => {
    let taskId = 'audit';
    while (parseInt(createHash('sha256').update(taskId).digest('hex').slice(0, 8), 16) % 20 !== 0) taskId += 'x';
    const result = await new CompletionVerificationOrchestrator(
      store,
      operations({ gate: async () => decision('skip') }),
      budgets,
    ).propose({ ...proposal, taskId });
    expect(result.action).toBe('complete');
    expect(store.read(taskId)?.decision).toMatchObject({
      action: 'independent_verify',
      recommendedAction: 'skip',
      auditedSkip: true,
    });
    expect(store.read(taskId)?.verifications).toBe(1);
  });

  it.each([false, true])(
    'runs an applicable deterministic checker and routes whitespace failure to repair: %s',
    async (fail) => {
      await writeFile(path.join(root, 'README.md'), fail ? 'Trailing whitespace  \n' : 'Clean\n');
      const input = {
        ...proposal,
        ...(await snapshotWorkspace(root)),
        criteria: 'git diff --check',
        quickCheck: 'diff_whitespace' as const,
      };
      const result = await new CompletionVerificationOrchestrator(
        store,
        operations({
          gate: async () => decision('quick_check'),
          quickCheck: runQuickCheck,
        }),
        budgets,
      ).propose(input);
      expect(result.action).toBe(fail ? 'repair' : 'complete');
      expect(store.read('task')?.decision?.action).toBe('quick_check');
      expect(store.read('task')?.report?.outcome).toBe(fail ? 'FAIL' : 'PASS');
    },
  );

  it.each(['staged', 'untracked'] as const)(
    'the deterministic checker fails on a %s whitespace error inside the attested revision',
    async (kind) => {
      if (kind === 'staged') {
        // `git diff --check` without HEAD cannot see a staged change.
        await writeFile(path.join(root, 'README.md'), 'Trailing whitespace  \n');
        await git('git', ['-C', root, 'add', 'README.md']);
      } else {
        await writeFile(path.join(root, 'notes.txt'), 'Trailing whitespace  \n');
      }
      const taskId = `task-${kind}`;
      const input = {
        ...proposal,
        taskId,
        ...(await snapshotWorkspace(root)),
        criteria: 'git diff --check',
        quickCheck: 'diff_whitespace' as const,
      };
      const result = await new CompletionVerificationOrchestrator(
        store,
        operations({
          gate: async () => decision('quick_check'),
          quickCheck: runQuickCheck,
        }),
        budgets,
      ).propose(input);
      expect(result.action).toBe('repair');
      expect(store.read(taskId)?.report?.outcome).toBe('FAIL');
    },
  );

  it('deduplicates concurrent completion events and rejects conflicting or late callbacks after restart', async () => {
    let release!: (value: unknown) => void;
    let request!: VerificationRequest;
    const waiting = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({
        verify: async (input) => {
          request = input;
          started();
          return waiting;
        },
      }),
      budgets,
    );
    const first = orchestrator.propose(proposal);
    expect(orchestrator.propose(proposal)).toBe(first);
    await ready;
    const reopened = new VerificationStore(path.join(root, '.git', 'verification.sqlite'));
    try {
      const restarted = new CompletionVerificationOrchestrator(reopened, operations(), budgets);
      expect((await restarted.propose(proposal)).action).toBe('blocked');
      release(report(request));
      expect((await first).action).toBe('blocked');
      expect(reopened.read('task')?.state).toBe('BLOCKED');
      expect(reopened.read('task')?.verifications).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it('persists repair consumption across restart and blocks a repair without progress', async () => {
    const initial = new CompletionVerificationOrchestrator(
      store,
      operations({ verify: async (request) => report(request, 'FAIL') }),
      budgets,
    );
    expect((await initial.propose(proposal)).action).toBe('repair');
    expect(store.read('task')?.repairs).toBe(1);
    store.close();
    store = new VerificationStore(path.join(root, '.git', 'verification.sqlite'));
    const restarted = new CompletionVerificationOrchestrator(store, operations(), budgets);
    expect((await restarted.propose(proposal)).action).toBe('blocked');
    expect(store.read('task')?.repairs).toBe(1);
  });

  it('repairs a real artifact and verifies the new revision without forwarding worker context', async () => {
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({
        verify: async (request) => {
          expect(JSON.stringify(request)).not.toContain('WORKER_PRIVATE_SENTINEL');
          const text = await readFile(path.join(request.environment, 'README.md'), 'utf8');
          return report(request, text.includes('Updated') ? 'PASS' : 'FAIL', `README contains: ${text}`);
        },
      }),
      budgets,
    );
    expect((await orchestrator.propose(proposal)).action).toBe('repair');
    await writeFile(path.join(root, 'README.md'), 'Updated\n');
    const repaired = { ...proposal, ...(await snapshotWorkspace(root)) };
    expect((await orchestrator.propose(repaired)).action).toBe('complete');
    expect(store.read('task')).toMatchObject({ repairs: 1, gates: 2, verifications: 2, state: 'COMPLETED' });
  });

  it('bounds repairs and gate attempts even when revisions and failures keep changing', async () => {
    let invocation = 0;
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({ verify: async (request) => report(request, 'FAIL', `Defect ${++invocation}`) }),
      { ...budgets, maxRepairs: 1 },
    );
    expect((await orchestrator.propose(proposal)).action).toBe('repair');
    expect((await orchestrator.propose(await revised())).action).toBe('blocked');
    expect(store.read('task')).toMatchObject({ repairs: 1, gates: 2 });
  });

  it('rejects a stale revision and mismatched attempt identifiers', async () => {
    const result = await new CompletionVerificationOrchestrator(
      store,
      operations({
        verify: async (request) => {
          await writeFile(path.join(root, 'README.md'), 'Changed while verifying\n');
          return { ...report(request), attemptId: 'stale-attempt' };
        },
      }),
      budgets,
    ).propose(proposal);
    expect(result.action).toBe('blocked');
    expect(store.read('task')?.state).toBe('BLOCKED');
  });

  it('times out an unresponsive verifier and ignores its eventual PASS', async () => {
    let release!: (value: unknown) => void;
    let request!: VerificationRequest;
    const waiting = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({
        verify: async (input) => {
          request = input;
          return waiting;
        },
      }),
      { ...budgets, operationTimeoutMs: 20 },
    );
    expect((await orchestrator.propose(proposal)).action).toBe('blocked');
    release(report(request));
    await Promise.resolve();
    expect(store.read('task')?.state).toBe('BLOCKED');
  });

  it.each(['skip', 'independent_verify'] as const)(
    'never authorizes %s after revision validation exceeds the deadline',
    async (action) => {
      const orchestrator = new CompletionVerificationOrchestrator(
        store,
        operations({
          gate: async () => decision(action),
          currentRevision: async () => {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return proposal.revision;
          },
        }),
        { ...budgets, taskTimeoutMs: 70, operationTimeoutMs: 70 },
      );
      expect((await orchestrator.propose(proposal)).action).toBe('blocked');
      expect(store.read('task')?.state).toBe('BLOCKED');
    },
  );

  it('cancels an in-flight verification without completing', async () => {
    const controller = new AbortController();
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({
        verify: async () => {
          controller.abort();
          return new Promise(() => {});
        },
      }),
      budgets,
    );
    expect((await orchestrator.propose(proposal, controller.signal)).action).toBe('blocked');
    expect(store.read('task')?.state).toBe('BLOCKED');
  });

  it('requires an audited administrative action to reopen a blocked task', async () => {
    await new CompletionVerificationOrchestrator(
      store,
      operations({ verify: async (request) => report(request, 'INCONCLUSIVE') }),
      budgets,
    ).propose(proposal);
    expect(() => store.recover('task', '', '')).toThrow();
    store.recover('task', 'human@example.test', 'Fixed unavailable verification environment');
    expect(store.read('task')).toBeUndefined();
    expect((await new CompletionVerificationOrchestrator(store, operations(), budgets).propose(proposal)).action).toBe(
      'complete',
    );
  });

  it('rejects a pre-recovery callback even when a new task reaches the same generation', async () => {
    const orchestrator = new CompletionVerificationOrchestrator(
      store,
      operations({ verify: async (request) => report(request, 'INCONCLUSIVE') }),
      budgets,
    );
    await orchestrator.propose(proposal);
    const old = store.read('task')!;
    store.recover('task', 'operator', 'Restart verification after fixing environment');
    await orchestrator.propose(proposal);
    const next = store.read('task')!;
    expect(next.epoch).not.toBe(old.epoch);
    // Even a record with the current generation cannot overwrite a different recovery epoch.
    expect(store.write({ ...old, generation: next.generation + 1, state: 'COMPLETED' }, next.generation)).toBe(false);
    expect(store.read('task')?.epoch).toBe(next.epoch);
  });

  it('read-only Git probes cannot execute repository fsmonitor or clean filters', async () => {
    const hook = path.join(root, '.git', 'probe-hook');
    const marker = path.join(root, '.git', 'executed-marker');
    await writeFile(hook, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`, { mode: 0o755 });
    await git('git', ['-C', root, 'config', 'core.fsmonitor', hook]);
    await verificationGit(root, ['ls-files', '-c', '-o', '--exclude-standard']);
    await expect(readFile(marker)).rejects.toThrow();
    await writeFile(path.join(root, '.gitattributes'), '*.md filter=fixture\n');
    await git('git', ['-C', root, 'config', 'filter.fixture.clean', hook]);
    await expect(verificationGit(root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).rejects.toThrow(
      'Executable Git filters',
    );
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('blocks only when a tracked path selects a configured filter', async () => {
    // A runner-wide configuration names a filter, the way "git lfs install --system" does.
    const ambient = path.join(root, '.git', 'ambient-config');
    await writeFile(ambient, '[filter "ambient"]\n\tclean = /bin/cat\n\tprocess = /bin/cat\n');
    vi.stubEnv('GIT_CONFIG_GLOBAL', ambient);
    // No path selects the filter, so Git converts nothing through it and verification runs.
    await expect(snapshotWorkspace(root)).resolves.toMatchObject({ files: expect.any(Array) });
    await expect(verificationGit(root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).resolves.toContain(
      'README.md',
    );
    // The same configuration blocks as soon as the repository binds a tracked path to it.
    await writeFile(path.join(root, '.gitattributes'), '*.md filter=ambient\n');
    await expect(verificationGit(root, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'])).rejects.toThrow(
      'Executable Git filters',
    );
  });

  it('detects tracked, staged, committed, and untracked changes and refuses symlink escapes', async () => {
    const before = (await snapshotWorkspace(root)).revision;
    await writeFile(path.join(root, 'new.txt'), 'A\n');
    const untracked = (await snapshotWorkspace(root)).revision;
    expect(untracked).not.toBe(before);
    await writeFile(path.join(root, 'new.txt'), 'B\n');
    expect((await snapshotWorkspace(root)).revision).not.toBe(untracked);
    await git('git', ['-C', root, 'add', '.']);
    const staged = (await snapshotWorkspace(root)).revision;
    await git('git', [
      '-C',
      root,
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'user.name=Fixture',
      'commit',
      '--quiet',
      '-m',
      'new',
    ]);
    expect((await snapshotWorkspace(root)).revision).not.toBe(staged);
    await symlink(os.tmpdir(), path.join(root, 'escape'));
    await expect(readVerificationFile(root, 'escape/anything')).rejects.toThrow();
    await expect(snapshotWorkspace(root)).rejects.toThrow();
  });

  it('treats executable and symlink documentation changes in both directions as code', async () => {
    await chmod(path.join(root, 'README.md'), 0o755);
    expect((await snapshotWorkspace(root)).classification).toBe('code');
    await git('git', ['-C', root, 'add', 'README.md']);
    await git('git', [
      '-C',
      root,
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'user.name=Fixture',
      'commit',
      '--quiet',
      '-m',
      'executable',
    ]);
    await chmod(path.join(root, 'README.md'), 0o644);
    expect((await snapshotWorkspace(root)).classification).toBe('code');
    await symlink('README.md', path.join(root, 'linked.md'));
    await git('git', ['-C', root, 'add', 'linked.md']);
    await git('git', [
      '-C',
      root,
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'user.name=Fixture',
      'commit',
      '--quiet',
      '-m',
      'symlink',
    ]);
    await rm(path.join(root, 'linked.md'));
    await writeFile(path.join(root, 'linked.md'), 'Regular file\n');
    expect((await snapshotWorkspace(root)).classification).toBe('code');
  });
});

it('the real verifier starts fresh, reads actual artifacts, and returns an inspectable report', async () => {
  const requests: StreamedModelTurnRequest[] = [];
  let factories = 0;
  const verifier = createIndependentVerifier({
    model: () => 'fixture',
    resolveModel: () => {
      factories++;
      return {
        async *stream(request) {
          requests.push(request);
          expect(JSON.stringify(request)).not.toContain('WORKER_PRIVATE_SENTINEL');
          expect(request.tools.map((tool) => tool.name)).toEqual(['verification_probe']);
          if (!request.input.some((item) => item.type === 'tool_result')) {
            const call = {
              type: 'tool_call' as const,
              name: 'verification_probe',
              id: 'probe',
              arguments: JSON.stringify({ kind: 'read_file', path: 'README.md' }),
            };
            yield call;
            yield { type: 'completion', responseId: 'probe', output: [call] };
          } else {
            const result = request.input.find((item) => item.type === 'tool_result');
            expect(result?.type === 'tool_result' && result.output).toContain('Revision');
            yield {
              type: 'completion',
              responseId: 'verdict',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        outcome: 'PASS',
                        evidence: 'Read README.md from disk',
                        checked: ['README.md'],
                        limitations: ['Static artifact check only'],
                      }),
                    },
                  ],
                },
              ],
            };
          }
        },
      } satisfies StreamedModelTurn;
    },
  });
  const result = await verifier(
    { goal: 'Read README', criteria: '', environment: root, revision: proposal.revision, attemptId: 'attempt' },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ outcome: 'PASS', attemptId: 'attempt', revision: proposal.revision });
  expect(requests).toHaveLength(2);
  expect(factories).toBe(1);
  expect(requests[0]!.input).toHaveLength(1);
});

it('a decision model failure over the real gate falls back rather than skipping', async () => {
  const gate = createVerificationGate({
    client: {
      decide: async () => {
        throw new Error('offline');
      },
    },
    model: () => 'jev',
  });
  expect(
    (await new CompletionVerificationOrchestrator(store, operations({ gate }), budgets).propose(proposal)).action,
  ).toBe('complete');
  expect(store.read('task')).toMatchObject({
    state: 'COMPLETED',
    gates: 1,
    verifications: 1,
    decision: { action: 'independent_verify' },
  });
});

it('a failed-only filesystem probe cannot authorize the real verifier PASS', async () => {
  const verifier = createIndependentVerifier({
    model: () => 'fixture',
    resolveModel: () => ({
      async *stream(request) {
        if (!request.input.some((item) => item.type === 'tool_result')) {
          const call = {
            type: 'tool_call' as const,
            name: 'verification_probe',
            id: 'missing',
            arguments: JSON.stringify({ kind: 'read_file', path: 'DOES-NOT-EXIST' }),
          };
          yield call;
          yield { type: 'completion', responseId: 'missing', output: [call] };
        } else {
          yield {
            type: 'completion',
            responseId: 'claimed-pass',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      outcome: 'PASS',
                      evidence: 'Claims correctness without evidence',
                      checked: ['read_file'],
                      limitations: [],
                    }),
                  },
                ],
              },
            ],
          };
        }
      },
    }),
  });
  await expect(
    verifier(
      {
        goal: proposal.goal,
        criteria: proposal.criteria,
        environment: root,
        revision: proposal.revision,
        attemptId: 'failed-probe',
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow('valid independent evidence');
});

it('the built-in administrative entry point inspects and auditably recovers the persisted task', async () => {
  const dataRoot = path.join(root, '.git', 'admin-data');
  vi.stubEnv('XDG_DATA_HOME', dataRoot);
  const adminStore = new VerificationStore(path.join(envPaths('term2').data, 'completion-verification.sqlite'));
  try {
    await new CompletionVerificationOrchestrator(
      adminStore,
      operations({ verify: async (request) => report(request, 'INCONCLUSIVE') }),
      budgets,
    ).propose(proposal);
    const adminScript = path.resolve('source/completion-verification-admin.ts');
    const runAdmin = async (args: string[]) => {
      // File-backed stdio also works in sandboxes that deny Node's socketpair handle inspection.
      const outputPath = path.join(root, '.git', 'admin-stdout');
      const errorPath = path.join(root, '.git', 'admin-stderr');
      const output = await open(outputPath, 'w');
      const errors = await open(errorPath, 'w');
      let code: number | null;
      try {
        const child = spawn(process.execPath, ['--import', 'tsx', adminScript, ...args], {
          env: { ...process.env, XDG_DATA_HOME: dataRoot },
          stdio: ['ignore', output.fd, errors.fd],
          timeout: 10_000,
        });
        code = await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', resolve);
        });
      } finally {
        await output.close();
        await errors.close();
      }
      expect(code, await readFile(errorPath, 'utf8')).toBe(0);
      return readFile(outputPath, 'utf8');
    };
    expect(JSON.parse(await runAdmin(['inspect', 'task'])).state).toBe('BLOCKED');
    expect(await runAdmin(['recover', 'task', 'fixture-operator', 'Fixed verification environment'])).toContain(
      'Administrative recovery recorded',
    );
    expect(adminStore.read('task')).toBeUndefined();
  } finally {
    adminStore.close();
  }
});

it('the run loop cannot mark a durable goal achieved before verification passes', async () => {
  let goal: DurableGoal = { id: 'goal', outcome: 'Update README', status: 'active' };
  const params = { status: 'achieved', evidence: 'WORKER_PRIVATE_SENTINEL' };
  const history = [
    { type: 'message', role: 'user', content: 'Update README' },
    { type: 'function_call', name: 'goal_check', callId: 'check', arguments: JSON.stringify(params) },
    {
      type: 'function_call_result',
      name: 'goal_check',
      callId: 'check',
      output: formatRecordedGoalCheck(goal.id, 'achieved'),
    },
  ];
  const agent: ApplicationAgent = {
    name: 'Worker',
    model: 'fixture',
    instructions: 'Work',
    tools: [
      {
        name: 'goal_check',
        description: 'Check',
        parameters: {},
        needsApproval: () => false,
        execute: async () => '',
        formatCommandMessage: () => [],
      },
    ],
  };
  const model: StreamedModelTurn = {
    async *stream() {
      yield {
        type: 'completion',
        responseId: 'worker-done',
        output: [{ type: 'message', content: [{ type: 'text', text: 'Done' }] }],
      };
    },
  };
  const orchestrator = new CompletionVerificationOrchestrator(
    store,
    operations({ verify: async (request) => report(request, 'INCONCLUSIVE') }),
    budgets,
  );
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  const stream = loop.startStream(agent, history, {
    onNormalStop: createVerifiedGoalStopPolicy({
      getGoal: () => goal,
      onGoalAchieved: (next) => {
        goal = next;
      },
      verify: () => orchestrator.propose(proposal),
    }),
  });
  await stream.completed;
  expect(goal.status).toBe('active');
  expect(stream.terminalCause).toBe('completion_verification_blocked');
  expect(stream.finalOutput).toContain('Completion verification blocked');
});

it('a repair deadline stops a nonresponsive model and retains the persisted repair budget', async () => {
  const orchestrator = new CompletionVerificationOrchestrator(
    store,
    operations({ verify: async (request) => report(request, 'FAIL') }),
    { ...budgets, taskTimeoutMs: 150 },
  );
  const verdict = await orchestrator.propose(proposal);
  expect(verdict.action).toBe('repair');
  let calls = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      async *stream() {
        if (++calls > 1) await new Promise(() => {});
        yield { type: 'completion', responseId: 'first', output: [] };
      },
    }),
  });
  const stream = loop.startStream({ name: 'Worker', model: 'fixture', instructions: '', tools: [] }, 'Work', {
    onNormalStop: () => ({ action: 'continue', reminder: 'Repair required', repairDeadline: verdict.record!.deadline }),
  });
  await stream.completed;
  expect(calls).toBe(2);
  expect(stream.terminalCause).toBe('completion_verification_blocked');
  expect(store.read('task')?.repairs).toBe(1);
});

it('new user steering supersedes an autonomous repair deadline without changing the persisted budget', async () => {
  const verdict = await new CompletionVerificationOrchestrator(
    store,
    operations({ verify: async (request) => report(request, 'FAIL') }),
    budgets,
  ).propose(proposal);
  expect(verdict.action).toBe('repair');
  let calls = 0;
  let stops = 0;
  const loop = new ApplicationRunLoop({
    resolveModel: () => ({
      async *stream() {
        if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 100));
        yield { type: 'completion', responseId: `round-${calls}`, output: [] };
      },
    }),
  });
  const stream = loop.startStream({ name: 'Worker', model: 'fixture', instructions: '', tools: [] }, 'Original', {
    onNormalStop: () => {
      if (++stops === 2) return { action: 'stop' };
      void loop.steer([{ type: 'message', role: 'user', content: 'Pause that task and answer another question' }]);
      return { action: 'continue', reminder: 'Repair old task', repairDeadline: Date.now() + 30 };
    },
  });
  await stream.completed;
  expect(stream.terminalCause).toBeUndefined();
  expect(calls).toBe(2);
  expect(store.read('task')).toMatchObject({ repairs: 1, state: 'REPAIR_REQUIRED' });
});

it('an unsupported workspace blocks with a named reason and an operational alert', async () => {
  const plain = await mkdtemp(path.join(os.tmpdir(), 'completion-verification-plain-'));
  const alerts: Record<string, unknown>[] = [];
  const logger = {
    ...createMockLogger(),
    error: (_message: string, meta?: Record<string, unknown>) => {
      if (meta) alerts.push(meta);
    },
  };
  const boundary = new RootCompletionBoundary({
    settings: createMockSettings({ 'memory.enabled': false }),
    logger,
    executionContext: createMockExecutionContext(plain),
    resolveModel: () => {
      throw new Error('the unsupported workspace must never reach a model');
    },
    model: () => 'fixture',
  });
  try {
    const verdict = await boundary.verify(
      { id: 'plain-goal', outcome: 'Do the thing', successCriteria: 'It is done', status: 'active' },
      [],
      new AbortController().signal,
    );
    expect(verdict.action).toBe('blocked');
    // The reason names the cause instead of collapsing into a generic failure.
    expect(verdict.action === 'blocked' ? verdict.reason : '').toContain('not inside a Git repository');
    expect(verdict.action === 'blocked' ? verdict.reason : '').not.toContain('goal persistence failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventType: 'completion_verification.operational_alert',
      reason: 'not-a-git-repository',
    });
    expect(alerts[0]?.taskId).toEqual(expect.any(String));
  } finally {
    boundary.dispose();
    await rm(plain, { recursive: true, force: true });
  }
});

it('the root AgentClient uses a separate provider instance and persists completion before closing the goal', async () => {
  vi.stubEnv('XDG_DATA_HOME', path.join(root, '.git', 'data'));
  const goal: DurableGoal = {
    id: 'root-goal',
    outcome: 'Read README',
    successCriteria: 'README contains Revision',
    status: 'active',
  };
  let currentGoal = goal;
  let instances = 0;
  let verifierRequests = 0;
  const provider = registerTestProvider({
    createStreamedModel: () => {
      const instance = ++instances;
      return {
        async *stream(request) {
          const verifier = request.tools.length === 1 && request.tools[0]?.name === 'verification_probe';
          if (verifier) {
            verifierRequests++;
            expect(instance).toBeGreaterThan(1);
            expect(JSON.stringify(request)).not.toContain('WORKER_PRIVATE_SENTINEL');
            if (!request.input.some((item) => item.type === 'tool_result')) {
              const call = {
                type: 'tool_call' as const,
                id: 'independent-read',
                name: 'verification_probe',
                arguments: JSON.stringify({ kind: 'read_file', path: 'README.md' }),
              };
              yield call;
              yield { type: 'completion', responseId: 'independent-read', output: [call] };
            } else {
              yield {
                type: 'completion',
                responseId: 'verified',
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify({
                          outcome: 'PASS',
                          evidence: 'README contains Revision, observed on disk',
                          checked: ['README contents'],
                          limitations: ['Content-only criterion'],
                        }),
                      },
                    ],
                  },
                ],
              };
            }
          } else if (!request.input.some((item) => item.type === 'tool_result')) {
            const call = {
              type: 'tool_call' as const,
              id: 'self-check',
              name: 'goal_check',
              arguments: JSON.stringify({
                status: 'achieved',
                evidence: 'WORKER_PRIVATE_SENTINEL',
                criteriaEvidence: 'README contains Revision',
              }),
            };
            yield call;
            yield { type: 'completion', responseId: 'self-check', output: [call] };
          } else {
            yield {
              type: 'completion',
              responseId: 'worker-done',
              output: [{ type: 'message', content: [{ type: 'text', text: 'Done' }] }],
            };
          }
        },
      } satisfies StreamedModelTurn;
    },
  });
  const client = new AgentClient({
    selection: { provider, model: 'fixture' },
    toolOwnership: new ToolOwnershipRegistry(),
    deps: {
      settings: createMockSettings({
        'agent.modelSelection': { provider, model: 'fixture' },
        'memory.enabled': false,
        'agent.contextCompaction.enabled': false,
      }),
      logger: createMockLogger(),
      executionContext: createMockExecutionContext(root),
      sessionContextService: createSessionContextService(),
      getGoal: () => currentGoal,
      onGoalAchieved: (value) => {
        currentGoal = value;
      },
    },
  });
  try {
    let stream = await client.startStream('Read README');
    await stream.completed;
    if (stream.interruptions?.length) {
      expect(currentGoal.status).toBe('active');
      for (const interruption of stream.interruptions) stream.state!.approve!(interruption);
      stream = await client.continueRunStream(stream.state!);
      await stream.completed;
    }
    expect(stream.terminalCause).toBeUndefined();
    expect(currentGoal.status).toBe('achieved');
    expect(verifierRequests).toBe(2);
    expect(instances).toBe(2);
  } finally {
    client.dispose();
  }
});
