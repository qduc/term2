import { describe, it, expect, vi } from 'vitest';
import { AgentConfiguration, type AgentConfigurationDeps } from './agent-configuration.js';
import { getAgentDefinition } from '../agent.js';
import { ExecutionContext } from '../services/execution-context.js';
import { registerProvider } from '../providers/registry.js';
import { ToolInterceptorRegistry } from './tool-interceptor-registry.js';
import { AskUserAnswerStore } from './ask-user-answer-store.js';
import { SubagentBridge } from './subagent-bridge.js';
import { getRunCodeAgentSpecAuthority } from '../tools/system/run-code/run-code.js';
import { pinWorkerWorktree } from '../services/subagents/worker-worktree.js';
import type { GitWorktree } from '../services/workspace/parse-worktree-list.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';

let providerRegistered = false;
function ensureProvider() {
  if (!providerRegistered) {
    registerProvider({
      id: 'mock-worktree-provider',
      label: 'Mock Worktree Provider',
      createStreamedModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'wt-test',
            output: [{ type: 'message', content: [{ type: 'text', text: 'ok' }] }],
          };
        },
      }),
      fetchModels: async () => [{ id: 'mock-model' }],
      clearConversations: () => {},
    });
    providerRegistered = true;
  }
}

function mockLogger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as any;
}

const REPO_HOME = '/repo';
const ALPHA_WORKTREE: GitWorktree = {
  path: '/repo/.worktrees/alpha',
  branch: 'alpha',
  detached: false,
  bare: false,
  locked: false,
  prunable: false,
};
const OUTSIDE_WORKTREE: GitWorktree = {
  path: '/outside/tree',
  branch: 'outside',
  detached: false,
  bare: false,
  locked: false,
  prunable: false,
};
const REPO_WORKTREES: GitWorktree[] = [
  { path: REPO_HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
  ALPHA_WORKTREE,
  OUTSIDE_WORKTREE,
];

describe('worktree authority wiring in production getAgentDefinition and AgentConfiguration', () => {
  it('getAgentDefinition populates worktreeScope with registered in-repo worktrees and excludes outside worktrees', () => {
    ensureProvider();
    const settings = createMockSettingsService();
    const logger = mockLogger();
    const executionContext = ExecutionContext.pin(REPO_HOME);

    const definition = getAgentDefinition({
      settingsService: settings,
      loggingService: logger,
      executionContext,
      listWorktreesSync: () => REPO_WORKTREES,
    });

    const runCode = definition.tools.find((t) => t.name === 'run_code');
    expect(runCode).toBeDefined();
    const authority = getRunCodeAgentSpecAuthority(runCode!);
    expect(authority).toBeDefined();
    expect(authority?.parent.worktreeScope).toContain('alpha');
    expect(authority?.parent.worktreeScope).not.toContain('outside');
    expect(authority?.parent.worktreeScope).not.toContain('main');
    expect((authority?.parent as any).worktreePaths).toEqual({
      alpha: '/repo/.worktrees/alpha',
    });
  });

  it('fails closed when remote, readOnly, or planMode is set', () => {
    ensureProvider();
    const settings = createMockSettingsService();
    const logger = mockLogger();

    // 1. Remote
    const remoteContext = new ExecutionContext({} as any, '/remote/path');
    const remoteDef = getAgentDefinition({
      settingsService: settings,
      loggingService: logger,
      executionContext: remoteContext,
      listWorktreesSync: () => REPO_WORKTREES,
    });
    const remoteRunCode = remoteDef.tools.find((t) => t.name === 'run_code');
    const remoteAuthority = getRunCodeAgentSpecAuthority(remoteRunCode!);
    expect(remoteAuthority?.parent.worktreeScope ?? []).toHaveLength(0);

    // 2. Read-only
    const readOnlyDef = getAgentDefinition({
      settingsService: settings,
      loggingService: logger,
      executionContext: ExecutionContext.pin(REPO_HOME),
      readOnly: true,
      listWorktreesSync: () => REPO_WORKTREES,
    });
    const readOnlyRunCode = readOnlyDef.tools.find((t) => t.name === 'run_code');
    const readOnlyAuthority = getRunCodeAgentSpecAuthority(readOnlyRunCode!);
    expect(readOnlyAuthority?.parent.worktreeScope ?? []).toHaveLength(0);

    // 3. Plan mode
    settings.set('app.planMode', true);
    const planDef = getAgentDefinition({
      settingsService: settings,
      loggingService: logger,
      executionContext: ExecutionContext.pin(REPO_HOME),
      listWorktreesSync: () => REPO_WORKTREES,
    });
    const planRunCode = planDef.tools.find((t) => t.name === 'run_code');
    const planAuthority = getRunCodeAgentSpecAuthority(planRunCode!);
    expect(planAuthority?.parent.worktreeScope ?? []).toHaveLength(0);
  });

  it('AgentConfiguration executes run_code agent launches: admits valid in-repo worktree with actual child pin, rejects malformed and outside', async () => {
    ensureProvider();
    const settings = createMockSettingsService();
    settings.set('agent.provider', 'mock-worktree-provider');
    settings.set('agent.model', 'mock-model');
    const logger = mockLogger();
    const executionContext = ExecutionContext.pin(REPO_HOME);

    let pinnedExecutionContext: ExecutionContext | undefined;
    let launchedWorktree: string | undefined;

    const mockSubagentManager = {
      runAsTool: vi.fn(async (request: any) => {
        launchedWorktree = request.worktree;
        // Exercise the real pinWorkerWorktree semantics to verify actual child pin
        const pin = await pinWorkerWorktree({
          name: request.worktree,
          role: request.role,
          homeRoot: REPO_HOME,
          isRemote: false,
          listWorktrees: async () => REPO_WORKTREES,
        });
        if (!pin.ok) {
          return { status: 'failed', error: pin.error, finalText: '', filesChanged: [], toolsUsed: [] };
        }
        pinnedExecutionContext = pin.executionContext;
        return {
          status: 'completed',
          finalText: `child pinned in ${pin.executionContext.getCwd()}`,
          worktreePath: pin.worktreePath,
          filesChanged: [],
          toolsUsed: [],
        };
      }),
      cancelAllAsyncRuns: () => {},
      resetMentorSession: () => {},
      clearCache: () => {},
      dispose: () => {},
    };

    const bridge = new SubagentBridge({
      logger,
      settings,
      sessionContextService: {
        getContext: () => null,
        runWithContext: (_c: unknown, fn: () => unknown) => fn(),
      } as any,
      chat: async () => '',
      createClient: () => ({}),
      subagentManager: mockSubagentManager as any,
    } as any);

    const agentConfig = new AgentConfiguration({}, {
      logger,
      settings,
      executionContext,
      sessionContextService: {
        getContext: () => null,
        runWithContext: (_c: unknown, fn: () => unknown) => fn(),
      } as any,
      toolInterceptorRegistry: new ToolInterceptorRegistry({ logger }),
      askUserAnswerStore: new AskUserAnswerStore(),
      getSubagentBridge: () => bridge,
      listWorktreesSync: () => REPO_WORKTREES,
    } as any);

    const applicationAgent = agentConfig.getApplicationAgent('test-session');
    const runCode = applicationAgent.tools.find((t) => t.name === 'run_code');
    expect(runCode).toBeDefined();

    // 1. Malformed relative name
    const malformedResult = await runCode!.execute(
      {
        code: `return await agent.run({ spec: { goal: 'test', tools: ['read_file'] }, worktree: '../outside' }).catch(e => e.message);`,
        description: 'test malformed worktree',
      },
      {} as any,
      {} as any,
    );
    expect(malformedResult).toContain('Worktree requests must be a non-empty opaque relative name');

    // 2. Outside worktree
    const outsideResult = await runCode!.execute(
      {
        code: `return await agent.run({ spec: { goal: 'test', tools: ['read_file'] }, worktree: 'outside' }).catch(e => e.message);`,
        description: 'test outside worktree',
      },
      {} as any,
      {} as any,
    );
    expect(outsideResult).toContain('Worktree "outside" is not in the parent authority scope');

    // 3. Valid in-repo worktree ('alpha')
    const validResult = await runCode!.execute(
      {
        code: `return await agent.run({ spec: { goal: 'test', tools: ['read_file'] }, worktree: 'alpha' });`,
        description: 'test valid worktree',
      },
      {} as any,
      {} as any,
    );
    expect(validResult).toContain('child pinned in /repo/.worktrees/alpha');
    expect(launchedWorktree).toBe('alpha');
    expect(pinnedExecutionContext).toBeDefined();
    expect(pinnedExecutionContext?.getCwd()).toBe('/repo/.worktrees/alpha');
  });

  it('rejects retargeted or moved worktrees before child effect in foreground and async script starts, while unchanged worktree launches', async () => {
    ensureProvider();
    const settings = createMockSettingsService();
    settings.set('agent.provider', 'mock-worktree-provider');
    settings.set('agent.model', 'mock-model');
    const logger = mockLogger();
    const executionContext = ExecutionContext.pin(REPO_HOME);

    let currentWorktrees: GitWorktree[] = [...REPO_WORKTREES];
    let childEffectExecuted = false;

    const mockSubagentManager = {
      runAsTool: vi.fn(async (request: any) => {
        const pin = await pinWorkerWorktree({
          name: request.worktree,
          role: request.role,
          homeRoot: REPO_HOME,
          isRemote: false,
          listWorktrees: async () => currentWorktrees,
          authorizedPath: request.authorizedWorktreePath,
        });
        if (!pin.ok) {
          return { status: 'failed', error: pin.error, finalText: '', filesChanged: [], toolsUsed: [] };
        }
        childEffectExecuted = true;
        return {
          status: 'completed',
          finalText: `child pinned in ${pin.executionContext.getCwd()}`,
          worktreePath: pin.worktreePath,
          filesChanged: ['mutated.txt'],
          toolsUsed: ['create_file'],
        };
      }),
      startRunAsync: vi.fn((request: any) => {
        const runId = 'async-run-1';
        let settledResult: any = null;
        const promise = (async () => {
          const pin = await pinWorkerWorktree({
            name: request.worktree,
            role: request.role,
            homeRoot: REPO_HOME,
            isRemote: false,
            listWorktrees: async () => currentWorktrees,
            authorizedPath: request.authorizedWorktreePath,
          });
          if (!pin.ok) {
            settledResult = { status: 'failed', error: pin.error, finalText: '', filesChanged: [], toolsUsed: [] };
          } else {
            childEffectExecuted = true;
            settledResult = {
              status: 'completed',
              finalText: `async child pinned in ${pin.executionContext.getCwd()}`,
              worktreePath: pin.worktreePath,
              filesChanged: ['mutated.txt'],
              toolsUsed: ['create_file'],
            };
          }
          return settledResult;
        })();
        return {
          runId,
          role: request.role,
          status: 'running',
          task: request.task,
          _promise: promise,
          _getResult: () => settledResult,
        };
      }),
      getRunResult: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const lastCall = mockSubagentManager.startRunAsync.mock.results.at(-1)?.value;
        if (lastCall?._promise) await lastCall._promise;
        return (
          lastCall?._getResult?.() ?? {
            status: 'failed',
            error: 'unknown',
            finalText: '',
            filesChanged: [],
            toolsUsed: [],
          }
        );
      }),
      getSubagentStatus: vi.fn((params: any) => ({ runId: params.runId, status: 'running' })),
      cancelAllAsyncRuns: () => {},
      resetMentorSession: () => {},
      clearCache: () => {},
      dispose: () => {},
    };

    const bridge = new SubagentBridge({
      logger,
      settings,
      sessionContextService: {
        getContext: () => null,
        runWithContext: (_c: unknown, fn: () => unknown) => fn(),
      } as any,
      chat: async () => '',
      createClient: () => ({}),
      subagentManager: mockSubagentManager as any,
    } as any);

    const agentConfig = new AgentConfiguration({}, {
      logger,
      settings,
      executionContext,
      sessionContextService: {
        getContext: () => null,
        runWithContext: (_c: unknown, fn: () => unknown) => fn(),
      } as any,
      toolInterceptorRegistry: new ToolInterceptorRegistry({ logger }),
      askUserAnswerStore: new AskUserAnswerStore(),
      getSubagentBridge: () => bridge,
      listWorktreesSync: () => REPO_WORKTREES,
    } as any);

    const applicationAgent = agentConfig.getApplicationAgent('test-session');
    const runCode = applicationAgent.tools.find((t) => t.name === 'run_code');
    expect(runCode).toBeDefined();

    // Now, simulate that alpha was MOVED outside the repository after root authority snapshot
    currentWorktrees = [
      { path: REPO_HOME, branch: 'main', detached: false, bare: false, locked: false, prunable: false },
      { path: '/outside/alpha', branch: 'alpha', detached: false, bare: false, locked: false, prunable: false },
      OUTSIDE_WORKTREE,
    ];

    // 1. Foreground script start rejects retargeted worktree before child effect
    childEffectExecuted = false;
    const fgRetargetResult = await runCode!.execute(
      {
        code: `return await agent.run({ spec: { goal: 'test', tools: ['read_file'] }, worktree: 'alpha' });`,
        description: 'test moved worktree in foreground',
      },
      {} as any,
      {} as any,
    );
    expect(fgRetargetResult).toContain('failed');
    expect(fgRetargetResult).toMatch(/does not match authorized path/);
    expect(childEffectExecuted).toBe(false);

    // 2. Async script start rejects retargeted worktree before child effect
    childEffectExecuted = false;
    const asyncRetargetResult = await runCode!.execute(
      {
        code: `const handle = await agent.start({ spec: { goal: 'test', tools: ['read_file'] }, worktree: 'alpha' });
return await agent.result({ runId: handle.runId });`,
        description: 'test moved worktree in async',
      },
      {} as any,
      {} as any,
    );
    expect(asyncRetargetResult).toContain('failed');
    expect(asyncRetargetResult).toMatch(/does not match authorized path/);
    expect(childEffectExecuted).toBe(false);

    // 3. Unchanged authorized tree still launches
    currentWorktrees = [...REPO_WORKTREES]; // restored to original path /repo/.worktrees/alpha
    childEffectExecuted = false;
    const unchangedResult = await runCode!.execute(
      {
        code: `return await agent.run({ spec: { goal: 'test', tools: ['read_file'] }, worktree: 'alpha' });`,
        description: 'test unchanged worktree',
      },
      {} as any,
      {} as any,
    );
    expect(unchangedResult).toContain('child pinned in /repo/.worktrees/alpha');
    expect(childEffectExecuted).toBe(true);
  });
});
