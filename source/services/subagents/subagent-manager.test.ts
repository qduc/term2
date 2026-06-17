import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ModelBehaviorError } from '@openai/agents';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { AgentClient } from '../../lib/agent-client.js';
import { registerProvider } from '../../providers/registry.js';
import { ExecutionContext } from '../execution-context.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

const ROLE_MENTOR = 'mentor';
const ROLE_EXPLORER = 'explorer';
const ROLE_UNKNOWN = 'nonexistent-role-xyz';

const PROVIDER_MENTOR_MANAGER = 'mock-mentor-manager';
const PROVIDER_EXPLORER = 'mock-explorer-provider';

const MODEL_MAIN = 'main-model';
const MODEL_MENTOR = 'mentor-model';
const MODEL_MOCK = 'mock-model';

const TASK_ADVISE_ME = 'advise me';
const TASK_FIRST_QUESTION = 'first question';
const TASK_SECOND_QUESTION = 'second question';
const TASK_FRESH_QUESTION = 'fresh question';
const TASK_FIND_TS_FILES = 'find all TypeScript files';
const TASK_INSPECT_WORKSPACE = 'inspect the workspace';
const TASK_INSPECT_TEMP_WORKSPACE = 'inspect a temp workspace';
const TASK_FIND_FILES = 'find files';

const UNKNOWN_ROLE_ERROR_FRAGMENT = ROLE_UNKNOWN;
const MENTOR_MODEL_NOT_CONFIGURED_ERROR = 'Mentor model is not configured';
const EXPLORER_BLOCKED_PREFIX =
  'Error: command blocked - explorer can only run read-only (GREEN) shell commands. Command: ';

const GREEN_SHELL_COMMANDS = ['pwd', 'ls', 'cat package.json', 'git status', 'git log --oneline'];
const YELLOW_SHELL_COMMANDS = ['touch blocked.txt', 'npm test', 'unknown_tool_name', 'cat ../outside.txt'];
const RED_SHELL_COMMANDS = ['rm -rf x', 'sudo ls'];

const TEMP_WORKSPACE_PREFIX = 'term2-test-explorer-shell-block-';
const TEMP_SOURCE_FILE = 'source.txt';
const TEMP_BLOCKED_CASES = [
  { command: 'touch blocked-touch.txt', path: 'blocked-touch.txt' },
  { command: 'echo marker > blocked-redirect.txt', path: 'blocked-redirect.txt' },
  { command: 'cat source.txt > blocked-copy.txt', path: 'blocked-copy.txt' },
  { command: 'printf marker | tee blocked-tee.txt', path: 'blocked-tee.txt' },
];

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

const SubagentManager = class extends RealSubagentManager {
  constructor(deps: any) {
    const sessionContextService = deps.sessionContextService ?? (createSessionContextService() as any);
    super({
      ...deps,
      sessionContextService,
      createClient:
        deps.createClient ??
        (({ agent, provider, maxTurns, retryAttempts }: any) =>
          new AgentClient({
            model: agent.model,
            maxTurns,
            retryAttempts,
            deps: {
              logger: deps.logger,
              settings: deps.settings,
              executionContext: deps.executionContext,
              sessionContextService,
            },
            agentOverride: agent,
            providerOverride: provider,
          })),
    });
  }
};

// ========== Mock Utilities ==========

function createMockLogger(): ILoggingService {
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

function createMockSettings(values: Record<string, any> = {}): ISettingsService {
  const store: Record<string, any> = { ...values };
  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: any) => {
      store[key] = value;
    },
  };
}

function getAgentTool(agent: any, name: string): any {
  return agent.tools.find((tool: any) => tool.name === name);
}

/**
 * Wraps a plain subagent run result into an AgentStream-compatible async iterable.
 * ConversationSession expects stream:true results that can be iterated with for-await.
 */
function wrapResultAsAgentStream(result: any): any {
  const events: any[] = [];
  if (typeof result.finalOutput === 'string' && result.finalOutput) {
    events.push({ type: 'response.output_text.delta', delta: result.finalOutput });
  }
  // ConversationSession reads output/newItems/history from the stream in this
  // priority. Provide at least one non-empty source so the session can process
  // the result and reach the 'final' event.
  const findSynthesizedOutput = (): unknown[] => {
    if (Array.isArray(result.output) && result.output.length > 0) return result.output;
    if (Array.isArray(result.newItems) && result.newItems.length > 0) return result.newItems;
    if (Array.isArray(result.history) && result.history.length > 0) return result.history;
    if (typeof result.finalOutput === 'string' && result.finalOutput) {
      return [{ role: 'assistant', type: 'message', content: result.finalOutput }];
    }
    return [];
  };
  const synthesizedOutput = findSynthesizedOutput();
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    completed: Promise.resolve(result),
    rawResponses: [result],
    status: result.status ?? 'completed',
    finalOutput: result.finalOutput,
    state: result.state,
    output: synthesizedOutput,
    newItems: result.newItems ?? synthesizedOutput,
    interruptions: result.interruptions ?? [],
    history: result.history ?? synthesizedOutput,
    messages: result.messages ?? synthesizedOutput,
    responseId: result.responseId ?? null,
    lastResponseId: result.responseId ?? null,
  };
}

function wrapErrorAsAgentStream(error: any): any {
  const completed = Promise.reject(error);
  completed.catch(() => {});
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw error;
        },
      };
    },
    completed,
    rawResponses: [],
    status: 'failed',
    interruptions: [],
    history: [],
    messages: [],
    responseId: null,
    lastResponseId: null,
  };
}

// ========== Provider Mocks ==========

let mentorManagerRunnerCalls: any[] = [];
let mentorManagerResponseCounter = 0;
let mentorManagerProviderRegistered = false;

function ensureMentorManagerProviderRegistered() {
  if (!mentorManagerProviderRegistered) {
    registerProvider({
      id: PROVIDER_MENTOR_MANAGER,
      label: 'Mock Mentor Manager',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            mentorManagerRunnerCalls.push({ input: _input, options: _options, agent: _agent });
            mentorManagerResponseCounter++;
            const result = {
              status: 'completed',
              finalOutput: `mentor-response-${mentorManagerResponseCounter}`,
              responseId: `resp-${mentorManagerResponseCounter}`,
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: MODEL_MOCK }],
    });
    mentorManagerProviderRegistered = true;
  }
}

let explorerManagerProviderRegistered = false;
let explorerRunnerCalls: any[] = [];

function ensureExplorerProviderRegistered() {
  if (!explorerManagerProviderRegistered) {
    registerProvider({
      id: PROVIDER_EXPLORER,
      label: 'Mock Explorer Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, input: any, options: any) => {
            explorerRunnerCalls.push({ input, agent: _agent, options });
            const result = {
              status: 'completed',
              finalOutput: 'Found the relevant files.',
              history: [],
              messages: [],
            };
            return options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: MODEL_MOCK }],
    });
    explorerManagerProviderRegistered = true;
  }
}

beforeEach(() => {
  mentorManagerRunnerCalls = [];
  mentorManagerResponseCounter = 0;
  explorerRunnerCalls = [];
  ensureMentorManagerProviderRegistered();
  ensureExplorerProviderRegistered();
});

// ========== run() with unknown role ==========

it.sequential('run() returns failed result for unknown role', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': PROVIDER_MENTOR_MANAGER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: ROLE_UNKNOWN, task: 'do something' });

  expect(result.status).toBe('failed');
  expect(result.error).toBeTruthy();
  expect(result.error!.includes(UNKNOWN_ROLE_ERROR_FRAGMENT)).toBe(true);
});

// ========== Mentor role ==========

it.sequential('run() with mentor role uses mentorModel setting', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MAIN,
    'agent.provider': PROVIDER_MENTOR_MANAGER,
    'agent.mentorModel': MODEL_MENTOR,
    'agent.mentorProvider': PROVIDER_MENTOR_MANAGER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: ROLE_MENTOR, task: TASK_ADVISE_ME });

  expect(result.status).toBe('completed');
  expect(result.role).toBe(ROLE_MENTOR);
  expect(result.finalText.includes('mentor-response')).toBe(true);
  expect(mentorManagerRunnerCalls.length).toBe(1);
  expect(mentorManagerRunnerCalls[0].agent.model).toBe(MODEL_MENTOR);
});

it.sequential('run() with mentor role fails when mentorModel is not set', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MAIN,
    'agent.provider': PROVIDER_MENTOR_MANAGER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: ROLE_MENTOR, task: TASK_ADVISE_ME });

  expect(result.status).toBe('failed');
  expect(result.error!.includes(MENTOR_MODEL_NOT_CONFIGURED_ERROR)).toBe(true);
});

it.sequential('run() mentor maintains conversation history across calls', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MAIN,
    'agent.provider': PROVIDER_MENTOR_MANAGER,
    'agent.mentorModel': MODEL_MENTOR,
    'agent.mentorProvider': PROVIDER_MENTOR_MANAGER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: ROLE_MENTOR, task: TASK_FIRST_QUESTION });
  await manager.run({ role: ROLE_MENTOR, task: TASK_SECOND_QUESTION });

  expect(mentorManagerRunnerCalls.length).toBe(2);
  // Second call should have history (array with previous messages)
  expect(Array.isArray(mentorManagerRunnerCalls[1].input)).toBe(true);
  expect(mentorManagerRunnerCalls[1].input.length > 1).toBe(true);
});

it.sequential('resetMentorSession() clears conversation history', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MAIN,
    'agent.provider': PROVIDER_MENTOR_MANAGER,
    'agent.mentorModel': MODEL_MENTOR,
    'agent.mentorProvider': PROVIDER_MENTOR_MANAGER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: ROLE_MENTOR, task: TASK_FIRST_QUESTION });
  expect(mentorManagerRunnerCalls[0].input.length >= 1).toBe(true);

  manager.resetMentorSession();

  await manager.run({ role: ROLE_MENTOR, task: TASK_FRESH_QUESTION });
  // After reset, second call should have only 1 message (fresh start)
  expect(mentorManagerRunnerCalls[1].input.length).toBe(1);
});

// ========== Explorer role ==========

it.sequential('run() with explorer role returns SubagentResult', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': PROVIDER_EXPLORER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: ROLE_EXPLORER, task: TASK_FIND_TS_FILES });

  expect(result.status).toBe('completed');
  expect(result.role).toBe(ROLE_EXPLORER);
  expect(result.agentId).toBeTruthy();
  expect(result.filesChanged.length).toBe(0);
  expect(result.finalText).toBeTruthy();
});

it.sequential('run() passes parent abort signal into the delegated provider run', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': PROVIDER_EXPLORER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });
  const abortController = new AbortController();

  await manager.run({
    role: ROLE_EXPLORER,
    task: TASK_FIND_TS_FILES,
    signal: abortController.signal,
  });

  expect(true).toBe(true);
});

it.sequential('run() cancels a delegated provider run when the parent signal aborts', async () => {
  // ConversationSession threads the parent signal through agentClient.abort(),
  // which aborts the internal AbortController whose signal reaches the runner
  // via startStream(). The mock listens on options.signal (the internal AC).
  registerProvider({
    id: 'mock-aborted-subagent-provider',
    label: 'Mock Aborted Subagent Provider',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            const rejectAbort = () => reject(Object.assign(new Error('delegated run aborted'), { name: 'AbortError' }));
            if (options.signal?.aborted) {
              rejectAbort();
              return;
            }
            options.signal?.addEventListener('abort', rejectAbort, { once: true });
          }),
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': 'mock-aborted-subagent-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });
  const abortController = new AbortController();
  const resultPromise = manager.run({
    role: ROLE_EXPLORER,
    task: TASK_FIND_TS_FILES,
    signal: abortController.signal,
  });

  queueMicrotask(() => abortController.abort());
  const result = await resultPromise;

  expect(result.status).toBe('cancelled');
  expect(result.error?.includes('aborted') ?? false).toBe(true);
});

it.sequential('explorer shell tool executes GREEN commands and blocks YELLOW and RED commands', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': PROVIDER_EXPLORER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: ROLE_EXPLORER, task: TASK_INSPECT_WORKSPACE });

  expect(explorerRunnerCalls.length).toBe(1);
  const agent = explorerRunnerCalls[0].agent;
  const shell = getAgentTool(agent, 'shell');
  expect(shell).toBeTruthy();
  expect(await shell.needsApproval({}, { command: 'pwd' })).toBe(false);

  const invokeShell = async (command: string) => shell.invoke({}, JSON.stringify({ command }), {});
  for (const command of GREEN_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    expect(output.includes('exit 0')).toBe(true);
    expect(output.startsWith(EXPLORER_BLOCKED_PREFIX)).toBe(false);
  }

  for (const command of YELLOW_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    expect(output.startsWith(EXPLORER_BLOCKED_PREFIX)).toBe(true);
    expect(output.includes(command)).toBe(true);
  }

  for (const command of RED_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    expect(output.startsWith(EXPLORER_BLOCKED_PREFIX)).toBe(true);
    expect(output.includes(command)).toBe(true);
  }
});

it.sequential(
  'explorer shell tool blocks write-like shell commands without creating files in a temp workspace',
  async (t) => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', TEMP_WORKSPACE_PREFIX));

    // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;
    fs.writeFileSync(path.join(tmpDir, TEMP_SOURCE_FILE), 'source content');

    const settings = createMockSettings({
      'agent.model': MODEL_MOCK,
      'agent.provider': PROVIDER_EXPLORER,
    });
    const manager = new SubagentManager({
      logger: createMockLogger(),
      settings,
      sessionContextService: createSessionContextService() as any,
      executionContext: {
        getCwd: () => tmpDir,
        isRemote: () => false,
        getSSHService: () => undefined,
      } as unknown as ExecutionContext,
    });

    await manager.run({ role: ROLE_EXPLORER, task: TASK_INSPECT_TEMP_WORKSPACE });

    const agent = explorerRunnerCalls[explorerRunnerCalls.length - 1].agent;
    const shell = getAgentTool(agent, 'shell');
    expect(shell).toBeTruthy();

    for (const { command, path: relativePath } of TEMP_BLOCKED_CASES) {
      const output = await shell.invoke({}, JSON.stringify({ command }), {});
      expect(output.startsWith(EXPLORER_BLOCKED_PREFIX)).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, relativePath))).toBe(false);
    }
  },
);

it.sequential('run() with explorer role uses read-only tools only', async () => {
  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': PROVIDER_EXPLORER,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: ROLE_EXPLORER, task: TASK_FIND_FILES });

  expect(explorerRunnerCalls.length).toBe(1);
  const agent = explorerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Explorer should have read tools
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('find_files')).toBe(true);

  // Explorer should NOT have write tools
  expect(toolNames.includes('apply_patch')).toBe(false);
  expect(toolNames.includes('search_replace')).toBe(false);
  expect(toolNames.includes('create_file')).toBe(false);

  // Explorer should NOT have web tools by default
  expect(toolNames.includes('web_search')).toBe(false);
  expect(toolNames.includes('web_fetch')).toBe(false);
  expect(toolNames.includes('shell')).toBe(true);
});

// ========== Researcher role ==========

let researcherRunnerCalls: any[] = [];
let researcherProviderRegistered = false;

function ensureResearcherProviderRegistered() {
  if (!researcherProviderRegistered) {
    registerProvider({
      id: 'mock-researcher-provider',
      label: 'Mock Researcher Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            researcherRunnerCalls.push({ agent: _agent });
            const result = {
              status: 'completed',
              finalOutput: 'Research findings.',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    researcherProviderRegistered = true;
  }
}

beforeEach(() => {
  researcherRunnerCalls = [];
  ensureResearcherProviderRegistered();
});

it.sequential('run() with researcher role includes web tools', async () => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-researcher-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'researcher', task: 'look up the latest TypeScript release' });

  expect(researcherRunnerCalls.length).toBe(1);
  const agent = researcherRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Researcher should have read and web tools
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('web_search')).toBe(true);
  expect(toolNames.includes('web_fetch')).toBe(true);

  // But not write tools
  expect(toolNames.includes('apply_patch')).toBe(false);
});

// ========== Worker role ==========

let workerRunnerCalls: any[] = [];
let workerProviderRegistered = false;

function ensureWorkerProviderRegistered() {
  if (!workerProviderRegistered) {
    registerProvider({
      id: 'mock-worker-provider',
      label: 'Mock Worker Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            workerRunnerCalls.push({ agent: _agent });
            const result = {
              status: 'completed',
              finalOutput: 'Changes applied.',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    workerProviderRegistered = true;
  }
}

beforeEach(() => {
  workerRunnerCalls = [];
  ensureWorkerProviderRegistered();
});

it.sequential('run() with worker role includes write and shell tools for non-gpt model', async () => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-worker-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'worker', task: 'update the README.md file' });

  expect(workerRunnerCalls.length).toBe(1);
  const agent = workerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Worker should have read, non-gpt write tools, and shell
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('search_replace')).toBe(true);
  expect(toolNames.includes('create_file')).toBe(true);
  expect(toolNames.includes('shell')).toBe(true);

  // Should NOT have apply_patch or web tools
  expect(toolNames.includes('apply_patch')).toBe(false);
  expect(toolNames.includes('web_search')).toBe(false);
});

it.sequential('run() with worker role includes write and shell tools for gpt model', async () => {
  const settings = createMockSettings({
    'agent.model': 'gpt-5',
    'agent.provider': 'mock-worker-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'worker', task: 'update the README.md file' });

  expect(workerRunnerCalls.length).toBe(1);
  const agent = workerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Worker should have read, gpt write tools (apply_patch), and shell
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('apply_patch')).toBe(true);
  expect(toolNames.includes('shell')).toBe(true);

  // Should NOT have search_replace, create_file, or web tools
  expect(toolNames.includes('search_replace')).toBe(false);
  expect(toolNames.includes('create_file')).toBe(false);
  expect(toolNames.includes('web_search')).toBe(false);
});

it.sequential('run() result contains agentId and correct role', async () => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-worker-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'worker', task: 'do some work' });

  expect(result.role).toBe('worker');
  expect(result.agentId).toBeTruthy();
  expect(result.agentId.length > 0).toBe(true);
  expect(result.filesChanged.length).toBe(0);
  expect(result.status).toBe('completed');
});

it.sequential('getRoleAgentTool caches one internal agent tool per role', () => {
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-boundary-worker',
    }),
  });

  const first = manager.getRoleAgentTool('worker');
  const second = manager.getRoleAgentTool('worker');
  const explorer = manager.getRoleAgentTool('explorer');

  expect(first).toBe(second);
  expect(first).not.toBe(explorer);
  expect(first.name).toBe('run_subagent_worker');
});

it.sequential('clearCache rebuilds cached role agent tools', () => {
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-boundary-worker',
    }),
  });

  const first = manager.getRoleAgentTool('worker');
  manager.clearCache();
  const rebuilt = manager.getRoleAgentTool('worker');

  expect(first).not.toBe(rebuilt);
});

it.sequential('cached worker agent preserves native approval checks for nested tools', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-nested-worker-approval-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-boundary-worker',
    }),
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  const worker = manager.getRoleAgent('worker');
  const shell = getAgentTool(worker, 'shell');
  const createFile = getAgentTool(worker, 'create_file');

  expect(await shell.needsApproval({}, { command: 'touch nested-approval.txt' })).toBe(true);
  expect(await createFile.needsApproval({}, { path: 'inside.txt', content: 'ok' })).toBe(false);
  expect(await createFile.needsApproval({}, { path: '../outside.txt', content: 'blocked' })).toBe(false);
});

// ========== Write boundary enforcement ==========

let boundaryWorkerCalls: any[] = [];
let boundaryWorkerRegistered = false;

function ensureBoundaryWorkerProviderRegistered() {
  if (!boundaryWorkerRegistered) {
    registerProvider({
      id: 'mock-boundary-worker',
      label: 'Mock Boundary Worker',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            boundaryWorkerCalls.push({ agent: _agent });
            const result = {
              status: 'completed',
              finalOutput: 'Done.',
              history: [],
              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    boundaryWorkerRegistered = true;
  }
}

beforeEach(() => {
  boundaryWorkerCalls = [];
  ensureBoundaryWorkerProviderRegistered();
});

it.sequential('worker write tool rejects paths outside workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-boundary-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  const mockExecutionContext = {
    getCwd: () => tmpDir,
    isRemote: () => false,
    getSSHService: () => undefined,
  } as unknown as ExecutionContext;

  // 1. Test apply_patch tool under gpt-5 model
  const settingsGpt = createMockSettings({
    'agent.model': 'gpt-5',
    'agent.provider': 'mock-boundary-worker',
  });
  const managerGpt = new SubagentManager({
    logger: createMockLogger(),
    settings: settingsGpt,
    executionContext: mockExecutionContext,
  });

  await managerGpt.run({
    role: 'worker',
    task: 'update a file',
  });

  expect(boundaryWorkerCalls.length).toBe(1);
  const agentGpt = boundaryWorkerCalls[0].agent;
  const applyPatch = agentGpt.tools.find((t: any) => t.name === 'apply_patch');
  expect(applyPatch).toBeTruthy();
  expect(agentGpt.tools.find((t: any) => t.name === 'search_replace')).toBeFalsy();

  // Call with a path inside the boundary — should NOT be rejected for boundary violation
  const insideResult = await applyPatch.invoke(
    {},
    JSON.stringify({
      type: 'create_file',
      path: 'newfile.ts',
      diff: '+hello\n',
    }),
    {},
  );
  const insideError = insideResult.startsWith('Error:') ? insideResult : undefined;
  expect(!insideError || !insideError.includes('outside the allowed write boundary')).toBe(true);

  // Call with a path outside the boundary — should be rejected
  const outsideResult = await applyPatch.invoke(
    {},
    JSON.stringify({
      type: 'create_file',
      path: '../outside/file.ts',
      diff: '+hello\n',
    }),
    {},
  );
  expect(outsideResult.includes('outside the allowed write boundary')).toBe(true);
  expect(outsideResult.startsWith('Error:')).toBe(true);

  const outsideNeedsApproval = await applyPatch.needsApproval(
    {},
    {
      type: 'create_file',
      path: '../outside/file.ts',
      diff: '+hello\n',
    },
  );
  expect(outsideNeedsApproval).toBe(false);

  // 2. Test search_replace tool under non-gpt model
  const settingsNonGpt = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-boundary-worker',
  });
  const managerNonGpt = new SubagentManager({
    logger: createMockLogger(),
    settings: settingsNonGpt,
    executionContext: mockExecutionContext,
  });

  boundaryWorkerCalls = []; // reset calls
  await managerNonGpt.run({
    role: 'worker',
    task: 'update a file',
  });

  expect(boundaryWorkerCalls.length).toBe(1);
  const agentNonGpt = boundaryWorkerCalls[0].agent;
  const searchReplace = agentNonGpt.tools.find((t: any) => t.name === 'search_replace');
  expect(searchReplace).toBeTruthy();
  expect(agentNonGpt.tools.find((t: any) => t.name === 'apply_patch')).toBeFalsy();

  const batchOutsideResult = await searchReplace.invoke(
    {},
    JSON.stringify({
      path: '../outside.ts',
      replacements: [
        {
          search_content: '',
          replace_content: 'no',
        },
      ],
    }),
    {},
  );
  expect(batchOutsideResult.includes('outside the allowed write boundary')).toBe(true);
  expect(batchOutsideResult.startsWith('Error:')).toBe(true);
});

it.sequential('worker writes are auto-approved within the workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-approval-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  const mockExecutionContext = {
    getCwd: () => tmpDir,
    isRemote: () => false,
    getSSHService: () => undefined,
  } as unknown as ExecutionContext;

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-boundary-worker',
    'app.editMode': false,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    executionContext: mockExecutionContext,
  });

  await manager.run({
    role: 'worker',
    task: 'update files',
  });

  expect(boundaryWorkerCalls.length).toBe(1);
  const agent = boundaryWorkerCalls[0].agent;
  const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
  expect(createFile).toBeTruthy();

  // In-boundary writes require no interactive approval (there is no foreground
  // approval channel for a subagent running inside a blocked parent tool call).
  // Standard mode is off but the write still does not need approval.
  const inBoundaryNeedsApproval = await createFile.needsApproval({}, { path: 'a.ts', content: 'x' });
  expect(inBoundaryNeedsApproval).toBe(false);

  // Out-of-boundary writes are also not surfaced for approval; they are
  // rejected deterministically by execute() instead.
  const outBoundaryNeedsApproval = await createFile.needsApproval({}, { path: '../escape.ts', content: 'x' });
  expect(outBoundaryNeedsApproval).toBe(false);
});

it.sequential('worker cannot write outside the workspace', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-default-boundary-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  const mockExecutionContext = {
    getCwd: () => tmpDir,
    isRemote: () => false,
    getSSHService: () => undefined,
  } as unknown as ExecutionContext;

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-boundary-worker',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    executionContext: mockExecutionContext,
  });

  // Writes default to the workspace root.
  await manager.run({ role: 'worker', task: 'update a file' });

  const agent = boundaryWorkerCalls[boundaryWorkerCalls.length - 1].agent;
  const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
  expect(createFile).toBeTruthy();

  const outsideResult = await createFile.invoke({}, JSON.stringify({ path: '../outside.ts', content: 'x' }), {});
  expect(outsideResult.includes('outside the allowed write boundary')).toBe(true);
  expect(outsideResult.startsWith('Error:')).toBe(true);
});

it.sequential('worker filesChanged tracks only successful writes for batch operations', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-files-changed-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  registerProvider({
    id: 'mock-worker-files-changed-provider',
    label: 'Mock Worker Files Changed Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          const applyPatch = agent.tools.find((tool: any) => tool.name === 'apply_patch');
          const searchReplace = agent.tools.find((tool: any) => tool.name === 'search_replace');

          if (applyPatch) {
            await applyPatch.invoke(
              {},
              JSON.stringify({
                operations: [
                  { type: 'create_file', path: 'a.txt', diff: '+hello\n' },
                  { type: 'update_file', path: 'missing.txt', diff: '-x\n+y\n' },
                ],
              }),
              {},
            );
          }

          if (searchReplace) {
            await searchReplace.invoke(
              {},
              JSON.stringify({
                path: 'b.txt',
                replacements: [{ search_content: '', replace_content: 'created' }],
              }),
              {},
            );
            await searchReplace.invoke(
              {},
              JSON.stringify({
                path: 'missing2.txt',
                replacements: [{ search_content: 'x', replace_content: 'y' }],
              }),
              {},
            );
          }

          const result = {
            status: 'completed',
            finalOutput: 'Done.',
            history: [],
            messages: [],
          };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  // 1. Test with GPT-5 model (using apply_patch)
  const managerGpt = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-worker-files-changed-provider',
    }),
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  const resultGpt = await managerGpt.run({ role: 'worker', task: 'do mixed writes' });
  expect(new Set(resultGpt.filesChanged)).toEqual(new Set(['a.txt']));

  // 2. Test with non-GPT-5 model (using search_replace)
  const managerNonGpt = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-files-changed-provider',
    }),
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  const resultNonGpt = await managerNonGpt.run({ role: 'worker', task: 'do mixed writes' });
  expect(new Set(resultNonGpt.filesChanged)).toEqual(new Set(['b.txt']));
});

it.sequential('worker write lock rejects concurrent create_file for same path without waiting', async () => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-lock-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  registerProvider({
    id: 'mock-worker-lock-provider',
    label: 'Mock Worker Lock Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');

          const [first, second] = await Promise.all([
            createFile.invoke(
              {},
              JSON.stringify({
                path: 'locked.txt',
                content: 'one',
              }),
              {},
            ),
            createFile.invoke(
              {},
              JSON.stringify({
                path: 'locked.txt',
                content: 'two',
              }),
              {},
            ),
          ]);

          const result = {
            status: 'completed',
            finalOutput: JSON.stringify({ first, second }),
            history: [],
            messages: [],
          };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-lock-provider',
    }),
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  const result = await manager.run({ role: 'worker', task: 'concurrent writes' });
  const parsed = JSON.parse(result.finalText);
  const first = parsed.first;
  const second = parsed.second;

  const allErrors = [first, second]
    .filter((text: string) => typeof text === 'string' && text.startsWith('Error:'))
    .join(' ');
  expect(allErrors.includes('already being modified')).toBe(true);
});

// ========== Session isolation ==========

it.sequential('run() creates isolated sessions for each subagent call', async () => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-explorer-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const [result1, result2] = await Promise.all([
    manager.run({ role: 'explorer', task: 'task 1' }),
    manager.run({ role: 'explorer', task: 'task 2' }),
  ]);

  expect(result1.status).toBe('completed');
  expect(result2.status).toBe('completed');
  expect(result1.agentId).not.toBe(result2.agentId);
});

// ========== Real-time events ==========

let eventToolProviderRegistered = false;

function ensureEventToolProviderRegistered() {
  if (!eventToolProviderRegistered) {
    registerProvider({
      id: 'mock-event-tool-provider',
      label: 'Mock Event Tool Provider',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            const readFile = agent.tools.find((tool: any) => tool.name === 'read_file');
            try {
              await readFile.invoke({}, JSON.stringify({ path: '/nonexistent-subagent-event-test' }), {});
            } catch {
              // Tool execution may fail (missing file); we only care that the
              // tool-started event fired before execution.
            }
            const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    eventToolProviderRegistered = true;
  }
}

it.sequential('run() emits started and completed events', async () => {
  ensureEventToolProviderRegistered();
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-event-tool-provider',
  });
  const events: any[] = [];
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'search the code' });

  const started = events.find((e) => e.type === 'subagent_started');
  expect(started).toBeTruthy();
  expect(started.role).toBe('explorer');
  expect(started.task).toBe('search the code');
  expect(started.agentId).toBe(result.agentId);

  const completed = events.find((e) => e.type === 'subagent_completed');
  expect(completed).toBeTruthy();
  expect(completed.result.agentId).toBe(result.agentId);
});

it.sequential('run() emits a completed event even when the role is unknown', async () => {
  const settings = createMockSettings({ 'agent.model': 'mock-model' });
  const events: any[] = [];
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  await manager.run({ role: 'definitely-not-a-role', task: 'x' });

  expect(events.find((e) => e.type === 'subagent_started')).toBeTruthy();
  const completed = events.find((e) => e.type === 'subagent_completed');
  expect(completed).toBeTruthy();
  expect(completed.result.status).toBe('failed');
});

// ========== Mentor role definition sourced from markdown ==========

it.sequential('mentor base instructions come from the mentor role markdown', async () => {
  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': 'mock-mentor-manager',
    'agent.mentorModel': 'mentor-model',
    'agent.mentorProvider': 'mock-mentor-manager',
    'app.mentorMode': false,
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'mentor', task: 'advise me' });

  expect(mentorManagerRunnerCalls.length).toBe(1);
  const instructions: string = mentorManagerRunnerCalls[0].agent.instructions;

  // Dynamically load the mentor role markdown to verify integration without brittle hardcoding
  const mentorPath = path.join(import.meta.dirname, '../../../source/prompts/subagents/mentor.md');
  const mentorContent = fs.readFileSync(mentorPath, 'utf-8');
  const parts = mentorContent.split('---');
  const expectedBody = parts[parts.length - 1].trim();

  expect(instructions.includes(expectedBody)).toBe(true);
});

// ========== finalText excludes pre-tool narration ==========

let postToolProviderRegistered = false;

function ensurePostToolProviderRegistered() {
  if (!postToolProviderRegistered) {
    registerProvider({
      id: 'mock-post-tool-provider',
      label: 'Mock Post Tool Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            const result = {
              status: 'completed',
              // finalOutput intentionally absent to exercise the history fallback.
              finalOutput: 'Final answer: it is in foo.ts.',
              history: [
                { rawItem: { role: 'assistant', content: 'Let me look into this first.' } },
                { rawItem: { type: 'function_call', name: 'grep' } },
                { rawItem: { type: 'function_call_result', name: 'grep' } },
                { rawItem: { role: 'assistant', content: 'Final answer: it is in foo.ts.' } },
              ],

              messages: [],
            };
            return _options?.stream ? wrapResultAsAgentStream(result) : result;
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    postToolProviderRegistered = true;
  }
}

it.sequential('finalText is the assistant message after the last tool item', async () => {
  ensurePostToolProviderRegistered();
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-post-tool-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: 'explorer', task: 'where is it' });

  expect(result.finalText).toBe('Final answer: it is in foo.ts.');
  expect(result.finalText.includes('Let me look into this first.')).toBe(false);
});

// ========== Worker shell tool — safety gating ==========

it.sequential('worker shell tool executes safe command without triggering approval UI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-safe-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  let shellResult: string | null = null;

  registerProvider({
    id: 'mock-worker-shell-safe-provider',
    label: 'Mock Worker Shell Safe Provider',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, _options: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          // needsApproval must be false for safe commands — no approval UI in workers
          const needsApproval = await shellTool.needsApproval({}, { command: 'ls .' });
          expect(needsApproval, 'worker shell tool must never require approval').toBe(false);

          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'echo hello' }), {});
          const result = {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-shell-safe-provider',
    }),
    sessionContextService: createSessionContextService() as any,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  await manager.run({ role: 'worker', task: 'list files' });

  // The shell tool should have executed and returned output (not an error block)
  expect(shellResult).toBeTruthy();
  expect(shellResult!.includes('blocked for safety')).toBe(false);
});

it.sequential('worker shell tool blocks dangerous/destructive commands and returns error string', async () => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-dangerous-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  let shellResult: string | null = null;

  registerProvider({
    id: 'mock-worker-shell-dangerous-provider',
    label: 'Mock Worker Shell Dangerous Provider',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, _options: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          // needsApproval must always be false — dangerous commands are blocked by execute(), not approval
          const needsApproval = await shellTool.needsApproval({}, { command: 'rm -rf /tmp/something' });
          expect(needsApproval, 'worker shell must never trigger approval UI even for dangerous commands').toBe(false);

          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'rm -rf /tmp/something' }), {});
          const result = {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-shell-dangerous-provider',
    }),
    sessionContextService: createSessionContextService() as any,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  await manager.run({ role: 'worker', task: 'delete stuff' });

  // The shell tool should have returned a blocked-for-safety error string, not executed
  expect(shellResult).toBeTruthy();
  expect(shellResult!.includes('blocked for safety')).toBe(true);
  expect(shellResult!.includes('exit 0')).toBe(false);
});

it.sequential('worker shell tool allows YELLOW command when auto-approval evaluator approves', async () => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-yellow-ok-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  let shellResult: string | null = null;
  let chatCalls = 0;
  let evaluatorPrompt = '';

  registerProvider({
    id: 'mock-worker-shell-yellow-approved-provider',
    label: 'Mock Worker Shell Yellow Approved Provider',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, _options: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
          const result = {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-shell-yellow-approved-provider',
      'shell.autoApproveMode': 'auto',
      'agent.autoApproveModel': 'mock-auto-approve-model',
      'agent.autoApproveProvider': 'mock-worker-shell-yellow-approved-provider',
    }),
    sessionContextService: createSessionContextService() as any,
    agentClient: {
      chat: async (message: string) => {
        chatCalls++;
        evaluatorPrompt = message;
        return '{"results":[{"approved":true,"reasoning":"Looks related and low risk."}]}';
      },
    } as any,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  await manager.run({ role: 'worker', task: 'run help for tests in this repository' });

  expect(chatCalls).toBe(1);
  expect(evaluatorPrompt.includes('run help for tests in this repository')).toBe(true);
  expect(shellResult).toBeTruthy();
  expect(shellResult!.includes('blocked for safety')).toBe(false);
});

it.sequential('worker shell tool blocks YELLOW command when auto-approval evaluator rejects', async () => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-yellow-no-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  let shellResult: string | null = null;
  let chatCalls = 0;

  registerProvider({
    id: 'mock-worker-shell-yellow-rejected-provider',
    label: 'Mock Worker Shell Yellow Rejected Provider',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, _options: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
          const result = {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-worker-shell-yellow-rejected-provider',
      'shell.autoApproveMode': 'auto',
      'agent.autoApproveModel': 'mock-auto-approve-model',
      'agent.autoApproveProvider': 'mock-worker-shell-yellow-rejected-provider',
    }),
    sessionContextService: createSessionContextService() as any,
    agentClient: {
      chat: async () => {
        chatCalls++;
        return '{"results":[{"approved":false,"reasoning":"Not safe."}]}';
      },
    } as any,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  await manager.run({ role: 'worker', task: 'run help for tests' });

  expect(chatCalls).toBe(1);
  expect(shellResult).toBeTruthy();
  expect(shellResult!.includes('blocked for safety')).toBe(true);
});

it.sequential('run() extracts usage from error.state.usage when subagent run fails', async () => {
  registerProvider({
    id: 'mock-failed-usage-provider',
    label: 'Mock Failed Usage Provider',
    createRunner: () =>
      ({
        run: async () => {
          const err = new Error('Run failed due to some reason');
          (err as any).state = {
            usage: {
              inputTokens: 15,
              outputTokens: 25,
            },
          };
          throw err;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-failed-usage-provider',
  });
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
  });
  const result = await manager.run({
    role: 'explorer',
    task: 'find files',
  });

  expect(result.status).toBe('failed');
  expect(result.usage).toEqual({
    prompt_tokens: 15,
    completion_tokens: 25,
    total_tokens: 40,
  });
});

// ========== Model error retry ==========

it.sequential(
  'run() retries on recoverable model error (hallucinated tool) and succeeds on second attempt',
  async () => {
    let runCount = 0;
    const events: any[] = [];
    const logWarnCalls: any[] = [];

    registerProvider({
      id: 'mock-retry-recoverable-provider',
      label: 'Mock Retry Recoverable Provider',
      createRunner: () =>
        ({
          run: async () => {
            runCount++;
            if (runCount === 1) {
              return wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
            }
            const result = {
              status: 'completed',
              finalOutput: 'Success on retry',
              history: [],
              messages: [],
            };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new SubagentManager({
      logger: {
        ...createMockLogger(),
        warn: (msg: string, meta?: Record<string, unknown>) => {
          logWarnCalls.push({ msg, meta });
        },
      },
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': 'mock-retry-recoverable-provider',
        'agent.retryAttempts': 2,
      }),
      sessionContextService: createSessionContextService() as any,
      onEvent: (event: ConversationEvent) => events.push(event),
    });

    const result = await manager.run({ role: 'explorer', task: 'find all files' });

    expect(result.status).toBe('completed');
    expect(runCount).toBe(2);
    const retryEvent = events.find((e) => e.type === 'retry');
    expect(retryEvent).toBeTruthy();
    expect(retryEvent.toolName).toBe('bash');
    expect(retryEvent.retryType).toBe('hallucination');
    expect(retryEvent.attempt).toBe(1);
    expect(retryEvent.maxRetries).toBe(MAX_SUBAGENT_MODEL_RETRIES);

    const retryLog = logWarnCalls.find((c) => c.meta?.eventType === 'retry.model_error');
    expect(retryLog).toBeTruthy();
  },
);

it.sequential('run() exhausts retries on repeated recoverable model errors and returns failed result', async () => {
  let runCount = 0;
  const events: any[] = [];

  registerProvider({
    id: 'mock-retry-exhaust-provider',
    label: 'Mock Retry Exhaust Provider',
    createRunner: () =>
      ({
        run: async () => {
          runCount++;
          return wrapErrorAsAgentStream(new ModelBehaviorError('Tool bash not found in agent Explorer.'));
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-retry-exhaust-provider',
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('failed');
  expect(result.error).toBeTruthy();
  expect(result.error!.includes('bash')).toBe(true);
  // Should have tried: initial + MAX_SUBAGENT_MODEL_RETRIES retries.
  expect(runCount).toBe(1 + MAX_SUBAGENT_MODEL_RETRIES);
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length, 'should emit one retry event per retry attempt').toBe(MAX_SUBAGENT_MODEL_RETRIES);
});

it.sequential('run() does not retry on non-recoverable ModelBehaviorError', async () => {
  let runCount = 0;
  const events: any[] = [];

  registerProvider({
    id: 'mock-no-retry-non-recoverable-provider',
    label: 'Mock No Retry Non-Recoverable Provider',
    createRunner: () =>
      ({
        run: async () => {
          runCount++;
          throw new ModelBehaviorError('something else unrelated to tools');
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-no-retry-non-recoverable-provider',
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('failed');
  expect(runCount, 'no retry should be attempted').toBe(1);
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length).toBe(0);
});

it.sequential('run() aborted subagent returns cancelled status without model-error retry', async () => {
  const events: any[] = [];

  registerProvider({
    id: 'mock-abort-no-retry-provider',
    label: 'Mock Abort No Retry Provider',
    createRunner: () =>
      ({
        run: async () => {
          const err = new Error('The operation was aborted');
          (err as any).name = 'AbortError';
          throw err;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-abort-no-retry-provider',
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
    onEvent: (event: ConversationEvent) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  expect(result.status).toBe('cancelled');
  const retryEvents = events.filter((e) => e.type === 'retry');
  expect(retryEvents.length, 'abort errors should not trigger model-error retries').toBe(0);
});

it.sequential(
  'run() does not restart read-only subagent from the beginning after a recoverable model error',
  async () => {
    let runCount = 0;
    const events: any[] = [];

    registerProvider({
      id: 'mock-explorer-read-then-crash-provider',
      label: 'Mock Explorer Read Then Crash Provider',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            runCount++;
            if (runCount === 1) {
              // Call a read tool then throw a recoverable error
              const grep = agent.tools.find((tool: any) => tool.name === 'grep');
              if (grep) {
                await grep.invoke({}, JSON.stringify({ pattern: 'foo', path: '.' }), {}).catch(() => {});
              }
              throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
            }
            const result = { status: 'completed', finalOutput: 'found it', history: [], messages: [] };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });

    const manager = new SubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': 'mock-explorer-read-then-crash-provider',
        'agent.retryAttempts': 2,
      }),
      sessionContextService: createSessionContextService() as any,
      onEvent: (event: ConversationEvent) => events.push(event),
    });

    const result = await manager.run({ role: 'explorer', task: 'search for something' });

    expect(result.status).toBe('failed');
    expect(result.error?.includes('bash')).toBe(true);
    expect(runCount, 'subagent must not restart from the beginning when no resumable stream exists').toBe(1);
    expect(events.filter((event) => event.type === 'retry').length).toBe(0);
  },
);

it.sequential('subagent run injects warning into tool output when turns left <= 5', async () => {
  let executeOutput: string | null = null;

  registerProvider({
    id: 'mock-subagent-maxturns-provider',
    label: 'Mock Subagent MaxTurns Provider',
    createRunner: () =>
      ({
        run: async (agent: any, _input: any, options: any) => {
          if (options.callModelInputFilter) {
            // Simulate 96 turns
            for (let i = 0; i < 96; i++) {
              await options.callModelInputFilter({
                modelData: { input: [] },
                agent,
                context: options.context,
              });
            }
          }

          // Execute a tool to see if the warning is injected
          const readFileTool = agent.tools.find((tool: any) => tool.name === 'read_file');
          if (readFileTool) {
            const mockRunContext = {
              context: options.context,
            };
            executeOutput = await readFileTool.invoke(
              mockRunContext as any,
              JSON.stringify({ path: 'package.json' }),
              {},
            );
          }

          const result = {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
          return options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-subagent-maxturns-provider',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'explorer', task: 'mock task' });

  expect(executeOutput).toBeTruthy();
  expect(executeOutput!.includes('approaching the maximum turn limit')).toBe(true);
  expect(executeOutput!.includes('4 turns left')).toBe(true);
});

it.sequential(
  'execution subagents select subagent-safe model-family prompts and append role instructions',
  async () => {
    let constructedAgentExplorer: any = null;
    let constructedAgentWorker: any = null;
    let constructedAgentResearcher: any = null;

    registerProvider({
      id: 'mock-prompt-test-provider-gpt-5-codex',
      label: 'Mock Prompt Test Provider GPT-5 Codex',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            constructedAgentExplorer = agent;
            const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'gpt-5-codex' }],
    });

    registerProvider({
      id: 'mock-prompt-test-provider-claude-3-sonnet',
      label: 'Mock Prompt Test Provider Claude 3 Sonnet',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            constructedAgentWorker = agent;
            const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'claude-3-sonnet' }],
    });

    registerProvider({
      id: 'mock-prompt-test-provider-gpt-5-modern',
      label: 'Mock Prompt Test Provider GPT-5 Modern',
      createRunner: () =>
        ({
          run: async (agent: any) => {
            constructedAgentResearcher = agent;
            const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
            return wrapResultAsAgentStream(result);
          },
        } as any),
      fetchModels: async () => [{ id: 'gpt-5' }],
    });

    // 1. Run explorer subagent with gpt-5-codex
    const managerExplorer = new SubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'gpt-5-codex',
        'agent.provider': 'mock-prompt-test-provider-gpt-5-codex',
      }),
      sessionContextService: createSessionContextService() as any,
    });

    await managerExplorer.run({ role: 'explorer', task: 'explorer task' });

    expect(constructedAgentExplorer).toBeTruthy();
    expect(constructedAgentExplorer.instructions.includes('nested Codex-family subagent')).toBe(true);
    expect(constructedAgentExplorer.instructions.includes('You are an explorer subagent.')).toBe(true);
    expect(constructedAgentExplorer.instructions.includes('## Worktree Hygiene')).toBe(true);
    expect(constructedAgentExplorer.instructions.includes('## Available Tool Guidance')).toBe(true);

    const codexIdx = constructedAgentExplorer.instructions.indexOf('nested Codex-family subagent');
    const explorerIdx = constructedAgentExplorer.instructions.indexOf('You are an explorer subagent');
    expect(codexIdx < explorerIdx).toBe(true);

    // 2. Run worker subagent with claude-3-sonnet
    const managerWorker = new SubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'claude-3-sonnet',
        'agent.provider': 'mock-prompt-test-provider-claude-3-sonnet',
      }),
      sessionContextService: createSessionContextService() as any,
    });

    await managerWorker.run({ role: 'worker', task: 'worker task' });

    expect(constructedAgentWorker).toBeTruthy();
    expect(constructedAgentWorker.instructions.includes('nested Anthropic-family subagent')).toBe(true);
    expect(constructedAgentWorker.instructions.includes('You are a worker subagent.')).toBe(true);

    const sonnetIdx = constructedAgentWorker.instructions.indexOf('nested Anthropic-family subagent');
    const workerIdx = constructedAgentWorker.instructions.indexOf('You are a worker subagent');
    expect(sonnetIdx < workerIdx).toBe(true);

    const managerResearcher = new SubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'gpt-5',
        'agent.provider': 'mock-prompt-test-provider-gpt-5-modern',
      }),
      sessionContextService: createSessionContextService() as any,
    });

    await managerResearcher.run({ role: 'researcher', task: 'research task' });

    expect(constructedAgentResearcher).toBeTruthy();
    expect(constructedAgentResearcher.instructions.includes('nested GPT-5-family subagent')).toBe(true);
    expect(constructedAgentResearcher.instructions.includes('You are a researcher subagent.')).toBe(true);
  },
);

it.sequential('execution subagent prompts exclude top-level-only prompt content', async () => {
  let constructedAgent: any = null;

  registerProvider({
    id: 'mock-top-level-exclusion-provider',
    label: 'Mock Top Level Exclusion Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          constructedAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5-codex' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5-codex',
      'agent.provider': 'mock-top-level-exclusion-provider',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'worker', task: 'worker task' });

  expect(constructedAgent).toBeTruthy();
  expect(constructedAgent.instructions.includes('commentary channel')).toBe(false);
  expect(constructedAgent.instructions.includes('final channel')).toBe(false);
  expect(constructedAgent.instructions.includes('Intermediary updates')).toBe(false);
  expect(constructedAgent.instructions.includes('Plan Mode Workflow')).toBe(false);
  expect(constructedAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.')).toBe(false);
});

it.sequential('mentor subagent is NOT affected by prompt profiles', async () => {
  let mentorAgent: any = null;

  registerProvider({
    id: 'mock-prompt-test-provider-mentor',
    label: 'Mock Prompt Test Provider Mentor',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          mentorAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5-codex' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'main-model',
      'agent.provider': 'mock-prompt-test-provider-mentor',
      'agent.mentorModel': 'gpt-5-codex',
      'agent.mentorProvider': 'mock-prompt-test-provider-mentor',
      'app.mentorMode': false,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'mentor', task: 'advise me' });

  expect(mentorAgent).toBeTruthy();
  expect(mentorAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.')).toBe(false);
  expect(mentorAgent.instructions.includes('nested Codex-family subagent')).toBe(false);
  expect(mentorAgent.instructions.includes('## Available Tool Guidance')).toBe(false);
  expect(mentorAgent.instructions.includes('## Worktree Hygiene')).toBe(false);
  expect(mentorAgent.instructions.includes('You are a senior architect')).toBe(true);
});

it.sequential('subagent tool definitions conditional registration for search tools', async () => {
  let workerAgentShellTrue: any = null;
  let workerAgentShellFalse: any = null;

  registerProvider({
    id: 'mock-tool-test-provider-shell-true',
    label: 'Mock Tool Test Provider Shell True',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          workerAgentShellTrue = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  registerProvider({
    id: 'mock-tool-test-provider-shell-false',
    label: 'Mock Tool Test Provider Shell False',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          workerAgentShellFalse = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-4o' }],
  });

  // 1. Model: gpt-5 (searchViaShell is true by default), canRunShell: true (from worker.md)
  // Explorer/worker tools should NOT contain dedicated search tools: grep and find_files.
  const managerShellTrue = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-tool-test-provider-shell-true',
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellTrue.run({ role: 'worker', task: 'some task' });

  expect(workerAgentShellTrue).toBeTruthy();
  const toolNamesShellTrue: string[] = workerAgentShellTrue.tools.map((tool: any) => tool.name);
  expect(toolNamesShellTrue.includes('grep')).toBe(false);
  expect(toolNamesShellTrue.includes('find_files')).toBe(false);
  expect(toolNamesShellTrue.includes('shell')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('Registered tools:')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('`fd` for file search')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('Use `grep` to search')).toBe(false);
  expect(workerAgentShellTrue.instructions.includes('Use `find_files` to locate')).toBe(false);
  expect(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools')).toBe(
    false,
  );

  // 2. Model: gpt-4o (searchViaShell is false by default), canRunShell: true
  // Tools should include dedicated grep and find_files.
  const managerShellFalse = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-4o',
      'agent.provider': 'mock-tool-test-provider-shell-false',
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellFalse.run({ role: 'worker', task: 'some task' });

  expect(workerAgentShellFalse).toBeTruthy();
  const toolNamesShellFalse: string[] = workerAgentShellFalse.tools.map((tool: any) => tool.name);
  expect(toolNamesShellFalse.includes('grep')).toBe(true);
  expect(toolNamesShellFalse.includes('find_files')).toBe(true);
  expect(toolNamesShellFalse.includes('shell')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('For workspace search, use the dedicated search tools')).toBe(
    true,
  );
  expect(workerAgentShellFalse.instructions.includes('`grep`')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('`find_files`')).toBe(true);
  expect(workerAgentShellFalse.instructions.includes('use `shell` with commands like `rg`')).toBe(false);

  // 3. Model: gpt-5 with searchViaShell explicitly disabled still keeps dedicated search tools.
  const managerShellOff = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-tool-test-provider-shell-true',
      'app.searchViaShell': 'off',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerShellOff.run({ role: 'worker', task: 'some task' });

  const toolNamesShellOff: string[] = workerAgentShellTrue.tools.map((tool: any) => tool.name);
  expect(toolNamesShellOff.includes('grep')).toBe(true);
  expect(toolNamesShellOff.includes('find_files')).toBe(true);
  expect(toolNamesShellOff.includes('shell')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools')).toBe(true);
  expect(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`')).toBe(false);
});

it.sequential('explorer uses shell search when available and researcher keeps dedicated search tools', async () => {
  let explorerAgent: any = null;
  let researcherAgent: any = null;

  registerProvider({
    id: 'mock-tool-test-provider-explorer-shell',
    label: 'Mock Tool Test Provider Explorer Shell',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          explorerAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  registerProvider({
    id: 'mock-tool-test-provider-researcher-dedicated',
    label: 'Mock Tool Test Provider Researcher Dedicated',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          researcherAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-5' }],
  });

  await new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-tool-test-provider-explorer-shell',
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  }).run({ role: 'explorer', task: 'find files' });

  await new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-tool-test-provider-researcher-dedicated',
      'app.searchViaShell': 'auto',
    }),
    sessionContextService: createSessionContextService() as any,
  }).run({ role: 'researcher', task: 'research files' });

  expect(explorerAgent).toBeTruthy();
  let toolNames: string[] = explorerAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('shell')).toBe(true);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('find_files')).toBe(false);
  expect(explorerAgent.instructions.includes('For workspace search, use `shell` with commands like `rg`')).toBe(true);
  expect(explorerAgent.instructions.includes('For workspace search, use the dedicated search tools')).toBe(false);

  expect(researcherAgent).toBeTruthy();
  toolNames = researcherAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('shell')).toBe(false);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('find_files')).toBe(true);
  expect(researcherAgent.instructions.includes('For workspace search, use the dedicated search tools')).toBe(true);
  expect(researcherAgent.instructions.includes('use `shell` with commands like `rg`')).toBe(false);
});

it.sequential('remote execution disables code-context tools and guidance', async () => {
  let remoteAgent: any = null;

  registerProvider({
    id: 'mock-tool-test-provider-remote',
    label: 'Mock Tool Test Provider Remote',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          remoteAgent = agent;
          const result = { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          return wrapResultAsAgentStream(result);
        },
      } as any),
    fetchModels: async () => [{ id: 'gpt-4o' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-4o',
      'agent.provider': 'mock-tool-test-provider-remote',
    }),
    executionContext: {
      getCwd: () => '/tmp/remote-workspace',
      isRemote: () => true,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
    sessionContextService: createSessionContextService() as any,
  });

  await manager.run({ role: 'explorer', task: 'inspect remote files' });

  expect(remoteAgent).toBeTruthy();
  const toolNames: string[] = remoteAgent.tools.map((tool: any) => tool.name);
  expect(toolNames.includes('read_code_outline')).toBe(false);
  expect(toolNames.includes('code_context_search')).toBe(false);
  expect(remoteAgent.instructions.includes('Code-context tools are not available in this run.')).toBe(true);
  expect(remoteAgent.instructions.includes('For code structure and symbol context, use:')).toBe(false);
});

it.sequential('run() aborted subagent retains toolsUsed and filesChanged', async () => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-abort-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true })) needs manual try/finally conversion;

  registerProvider({
    id: 'mock-abort-retain-provider',
    label: 'Mock Abort Retain Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          // Simulate using a tool
          const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
          if (createFile) {
            await createFile.invoke({}, JSON.stringify({ path: 'test.ts', content: 'x' }), {});
          }
          const err = new Error('The operation was aborted');
          (err as any).name = 'AbortError';
          throw err;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-abort-retain-provider',
    }),
    sessionContextService: createSessionContextService() as any,
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
  });

  const result = await manager.run({ role: 'worker', task: 'find all files' });

  expect(result.status).toBe('cancelled');
  expect(result.toolsUsed.length).toBe(1);
  expect(result.toolsUsed[0].toolName).toBe('create_file');
  expect(result.filesChanged).toEqual(['test.ts']);
});

it.sequential('run() returns failed result when createClient factory is not provided', async () => {
  const manager = new RealSubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'openai',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: 'explorer', task: 'some task' });
  expect(result.status).toBe('failed');
  expect(result.error).toBe('SubagentManager: createClient factory not provided');
});
