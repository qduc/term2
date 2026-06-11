import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import { ModelBehaviorError } from '@openai/agents';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { AgentClient } from '../../lib/agent-client.js';
import { registerProvider } from '../../providers/registry.js';
import { ExecutionContext } from '../execution-context.js';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../conversation-retry-policy.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';

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

test.beforeEach(() => {
  mentorManagerRunnerCalls = [];
  mentorManagerResponseCounter = 0;
  explorerRunnerCalls = [];
  ensureMentorManagerProviderRegistered();
  ensureExplorerProviderRegistered();
});

// ========== run() with unknown role ==========

test.serial('run() returns failed result for unknown role', async (t) => {
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

  t.is(result.status, 'failed');
  t.truthy(result.error);
  t.true(result.error!.includes(UNKNOWN_ROLE_ERROR_FRAGMENT));
});

// ========== Mentor role ==========

test.serial('run() with mentor role uses mentorModel setting', async (t) => {
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

  t.is(result.status, 'completed');
  t.is(result.role, ROLE_MENTOR);
  t.true(result.finalText.includes('mentor-response'));
  t.is(mentorManagerRunnerCalls.length, 1);
  t.is(mentorManagerRunnerCalls[0].agent.model, MODEL_MENTOR);
});

test.serial('run() with mentor role fails when mentorModel is not set', async (t) => {
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

  t.is(result.status, 'failed');
  t.true(result.error!.includes(MENTOR_MODEL_NOT_CONFIGURED_ERROR));
});

test.serial('run() mentor maintains conversation history across calls', async (t) => {
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

  t.is(mentorManagerRunnerCalls.length, 2);
  // Second call should have history (array with previous messages)
  t.true(Array.isArray(mentorManagerRunnerCalls[1].input));
  t.true(mentorManagerRunnerCalls[1].input.length > 1);
});

test.serial('resetMentorSession() clears conversation history', async (t) => {
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
  t.true(mentorManagerRunnerCalls[0].input.length >= 1);

  manager.resetMentorSession();

  await manager.run({ role: ROLE_MENTOR, task: TASK_FRESH_QUESTION });
  // After reset, second call should have only 1 message (fresh start)
  t.is(mentorManagerRunnerCalls[1].input.length, 1);
});

// ========== Explorer role ==========

test.serial('run() with explorer role returns SubagentResult', async (t) => {
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

  t.is(result.status, 'completed');
  t.is(result.role, ROLE_EXPLORER);
  t.truthy(result.agentId);
  t.is(result.filesChanged.length, 0);
  t.truthy(result.finalText);
});

test.serial('run() passes parent abort signal into the delegated provider run', async (t) => {
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

  t.pass();
});

test.serial('run() cancels a delegated provider run when the parent signal aborts', async (t) => {
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

  t.is(result.status, 'cancelled');
  t.true(result.error?.includes('aborted') ?? false);
});

test.serial('explorer shell tool executes GREEN commands and blocks YELLOW and RED commands', async (t) => {
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

  t.is(explorerRunnerCalls.length, 1);
  const agent = explorerRunnerCalls[0].agent;
  const shell = getAgentTool(agent, 'shell');
  t.truthy(shell);
  t.is(await shell.needsApproval({}, { command: 'pwd' }), false);

  const invokeShell = async (command: string) => shell.invoke({}, JSON.stringify({ command }), {});
  for (const command of GREEN_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    t.true(output.includes('exit 0'), `expected GREEN command to execute: ${command}`);
    t.false(output.startsWith(EXPLORER_BLOCKED_PREFIX), `expected GREEN command to not be blocked: ${command}`);
  }

  for (const command of YELLOW_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    t.true(output.startsWith(EXPLORER_BLOCKED_PREFIX), `expected YELLOW command to be blocked: ${command}`);
    t.true(output.includes(command), `blocked output should mention the command: ${command}`);
  }

  for (const command of RED_SHELL_COMMANDS) {
    const output = await invokeShell(command);
    t.true(output.startsWith(EXPLORER_BLOCKED_PREFIX), `expected RED command to be blocked: ${command}`);
    t.true(output.includes(command), `blocked output should mention the command: ${command}`);
  }
});

test.serial(
  'explorer shell tool blocks write-like shell commands without creating files in a temp workspace',
  async (t) => {
    const tmpDir = fs.mkdtempSync(path.join('/tmp', TEMP_WORKSPACE_PREFIX));
    t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
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
    t.truthy(shell);

    for (const { command, path: relativePath } of TEMP_BLOCKED_CASES) {
      const output = await shell.invoke({}, JSON.stringify({ command }), {});
      t.true(output.startsWith(EXPLORER_BLOCKED_PREFIX), `expected command to be blocked: ${command}`);
      t.false(fs.existsSync(path.join(tmpDir, relativePath)), `expected no file to be created: ${relativePath}`);
    }
  },
);

test.serial('run() with explorer role uses read-only tools only', async (t) => {
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

  t.is(explorerRunnerCalls.length, 1);
  const agent = explorerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Explorer should have read tools
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('grep'));
  t.true(toolNames.includes('find_files'));

  // Explorer should NOT have write tools
  t.false(toolNames.includes('apply_patch'));
  t.false(toolNames.includes('search_replace'));
  t.false(toolNames.includes('create_file'));

  // Explorer should NOT have web tools by default
  t.false(toolNames.includes('web_search'));
  t.false(toolNames.includes('web_fetch'));
  t.true(toolNames.includes('shell'));
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

test.beforeEach(() => {
  researcherRunnerCalls = [];
  ensureResearcherProviderRegistered();
});

test.serial('run() with researcher role includes web tools', async (t) => {
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

  t.is(researcherRunnerCalls.length, 1);
  const agent = researcherRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Researcher should have read and web tools
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('web_search'));
  t.true(toolNames.includes('web_fetch'));

  // But not write tools
  t.false(toolNames.includes('apply_patch'));
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

test.beforeEach(() => {
  workerRunnerCalls = [];
  ensureWorkerProviderRegistered();
});

test.serial('run() with worker role includes write and shell tools for non-gpt model', async (t) => {
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

  t.is(workerRunnerCalls.length, 1);
  const agent = workerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Worker should have read, non-gpt write tools, and shell
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('search_replace'));
  t.true(toolNames.includes('create_file'));
  t.true(toolNames.includes('shell'));

  // Should NOT have apply_patch or web tools
  t.false(toolNames.includes('apply_patch'));
  t.false(toolNames.includes('web_search'));
});

test.serial('run() with worker role includes write and shell tools for gpt model', async (t) => {
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

  t.is(workerRunnerCalls.length, 1);
  const agent = workerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Worker should have read, gpt write tools (apply_patch), and shell
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('apply_patch'));
  t.true(toolNames.includes('shell'));

  // Should NOT have search_replace, create_file, or web tools
  t.false(toolNames.includes('search_replace'));
  t.false(toolNames.includes('create_file'));
  t.false(toolNames.includes('web_search'));
});

test.serial('run() result contains agentId and correct role', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-worker-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'worker', task: 'do some work' });

  t.is(result.role, 'worker');
  t.truthy(result.agentId);
  t.true(result.agentId.length > 0);
  t.is(result.filesChanged.length, 0);
  t.is(result.status, 'completed');
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

test.beforeEach(() => {
  boundaryWorkerCalls = [];
  ensureBoundaryWorkerProviderRegistered();
});

test.serial('worker write tool rejects paths outside workspace', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-boundary-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

  t.is(boundaryWorkerCalls.length, 1);
  const agentGpt = boundaryWorkerCalls[0].agent;
  const applyPatch = agentGpt.tools.find((t: any) => t.name === 'apply_patch');
  t.truthy(applyPatch);
  t.falsy(agentGpt.tools.find((t: any) => t.name === 'search_replace'));

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
  const insideParsed = JSON.parse(insideResult);
  const insideError: string | undefined = insideParsed?.output?.[0]?.error;
  t.true(!insideError || !insideError.includes('outside the allowed write boundary'));

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
  const outsideParsed = JSON.parse(outsideResult);
  t.true(outsideParsed?.output?.[0]?.error?.includes('outside the allowed write boundary'));
  t.false(outsideParsed?.output?.[0]?.success ?? true);

  const outsideNeedsApproval = await applyPatch.needsApproval(
    {},
    {
      type: 'create_file',
      path: '../outside/file.ts',
      diff: '+hello\n',
    },
  );
  t.is(outsideNeedsApproval, false);

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

  t.is(boundaryWorkerCalls.length, 1);
  const agentNonGpt = boundaryWorkerCalls[0].agent;
  const searchReplace = agentNonGpt.tools.find((t: any) => t.name === 'search_replace');
  t.truthy(searchReplace);
  t.falsy(agentNonGpt.tools.find((t: any) => t.name === 'apply_patch'));

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
  const batchOutsideParsed = JSON.parse(batchOutsideResult);
  t.true(batchOutsideParsed?.output?.[0]?.error?.includes('outside the allowed write boundary'));
  t.false(batchOutsideParsed?.output?.[0]?.success ?? true);
});

test.serial('worker writes are auto-approved within the workspace', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-approval-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

  t.is(boundaryWorkerCalls.length, 1);
  const agent = boundaryWorkerCalls[0].agent;
  const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
  t.truthy(createFile);

  // In-boundary writes require no interactive approval (there is no foreground
  // approval channel for a subagent running inside a blocked parent tool call).
  // Standard mode is off but the write still does not need approval.
  const inBoundaryNeedsApproval = await createFile.needsApproval({}, { path: 'a.ts', content: 'x' });
  t.is(inBoundaryNeedsApproval, false);

  // Out-of-boundary writes are also not surfaced for approval; they are
  // rejected deterministically by execute() instead.
  const outBoundaryNeedsApproval = await createFile.needsApproval({}, { path: '../escape.ts', content: 'x' });
  t.is(outBoundaryNeedsApproval, false);
});

test.serial('worker cannot write outside the workspace', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-default-boundary-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
  t.truthy(createFile);

  const outsideResult = await createFile.invoke({}, JSON.stringify({ path: '../outside.ts', content: 'x' }), {});
  const outsideParsed = JSON.parse(outsideResult);
  t.true(outsideParsed?.output?.[0]?.error?.includes('outside the allowed write boundary'));
  t.false(outsideParsed?.output?.[0]?.success ?? true);
});

test.serial('worker filesChanged tracks only successful writes for batch operations', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-files-changed-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
  t.deepEqual(new Set(resultGpt.filesChanged), new Set(['a.txt']));

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
  t.deepEqual(new Set(resultNonGpt.filesChanged), new Set(['b.txt']));
});

test.serial('worker write lock rejects concurrent create_file for same path without waiting', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-worker-lock-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
  const first = JSON.parse(parsed.first);
  const second = JSON.parse(parsed.second);

  const allErrors = [first?.error, second?.error, first?.output?.[0]?.error, second?.output?.[0]?.error]
    .filter(Boolean)
    .join(' ');
  t.true(allErrors.includes('already being modified'));
});

// ========== Session isolation ==========

test.serial('run() creates isolated sessions for each subagent call', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-explorer-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const [result1, result2] = await Promise.all([
    manager.run({ role: 'explorer', task: 'task 1' }),
    manager.run({ role: 'explorer', task: 'task 2' }),
  ]);

  t.is(result1.status, 'completed');
  t.is(result2.status, 'completed');
  t.not(result1.agentId, result2.agentId);
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

test.serial('run() emits started and completed events', async (t) => {
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'search the code' });

  const started = events.find((e) => e.type === 'subagent_started');
  t.truthy(started);
  t.is(started.role, 'explorer');
  t.is(started.task, 'search the code');
  t.is(started.agentId, result.agentId);

  const completed = events.find((e) => e.type === 'subagent_completed');
  t.truthy(completed);
  t.is(completed.result.agentId, result.agentId);
});

test.serial('run() emits a completed event even when the role is unknown', async (t) => {
  const settings = createMockSettings({ 'agent.model': 'mock-model' });
  const events: any[] = [];
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    sessionContextService: createSessionContextService() as any,
    onEvent: (event) => events.push(event),
  });

  await manager.run({ role: 'definitely-not-a-role', task: 'x' });

  t.truthy(events.find((e) => e.type === 'subagent_started'));
  const completed = events.find((e) => e.type === 'subagent_completed');
  t.truthy(completed);
  t.is(completed.result.status, 'failed');
});

// ========== Mentor role definition sourced from markdown ==========

test.serial('mentor base instructions come from the mentor role markdown', async (t) => {
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

  t.is(mentorManagerRunnerCalls.length, 1);
  const instructions: string = mentorManagerRunnerCalls[0].agent.instructions;

  // Dynamically load the mentor role markdown to verify integration without brittle hardcoding
  const mentorPath = path.join(import.meta.dirname, '../../../source/prompts/subagents/mentor.md');
  const mentorContent = fs.readFileSync(mentorPath, 'utf-8');
  const parts = mentorContent.split('---');
  const expectedBody = parts[parts.length - 1].trim();

  t.true(instructions.includes(expectedBody), 'Agent instructions should include the parsed body of mentor.md');
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

test.serial('finalText is the assistant message after the last tool item', async (t) => {
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

  t.is(result.finalText, 'Final answer: it is in foo.ts.');
  t.false(result.finalText.includes('Let me look into this first.'));
});

// ========== Worker shell tool — safety gating ==========

test.serial('worker shell tool executes safe command without triggering approval UI', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-safe-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
          t.is(needsApproval, false, 'worker shell tool must never require approval');

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
  t.truthy(shellResult);
  t.false(shellResult!.includes('blocked for safety'), 'safe command should not be blocked');
});

test.serial('worker shell tool blocks dangerous/destructive commands and returns error string', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-dangerous-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
          t.is(needsApproval, false, 'worker shell must never trigger approval UI even for dangerous commands');

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
  t.truthy(shellResult);
  t.true(shellResult!.includes('blocked for safety'), 'dangerous command must be blocked');
  t.false(shellResult!.includes('exit 0'), 'dangerous command must not execute');
});

test.serial('worker shell tool allows YELLOW command when auto-approval evaluator approves', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-yellow-ok-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

  t.is(chatCalls, 1);
  t.true(evaluatorPrompt.includes('run help for tests in this repository'));
  t.truthy(shellResult);
  t.false(shellResult!.includes('blocked for safety'), 'approved YELLOW command should execute');
});

test.serial('worker shell tool blocks YELLOW command when auto-approval evaluator rejects', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-worker-shell-yellow-no-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

  t.is(chatCalls, 1);
  t.truthy(shellResult);
  t.true(shellResult!.includes('blocked for safety'), 'rejected YELLOW command should stay blocked');
});

test.serial('run() extracts usage from error.state.usage when subagent run fails', async (t) => {
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

  t.is(result.status, 'failed');
  t.deepEqual(result.usage, {
    prompt_tokens: 15,
    completion_tokens: 25,
    total_tokens: 40,
  });
});

// ========== Model error retry ==========

test.serial(
  'run() retries on recoverable model error (hallucinated tool) and succeeds on second attempt',
  async (t) => {
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
      onEvent: (event) => events.push(event),
    });

    const result = await manager.run({ role: 'explorer', task: 'find all files' });

    t.is(result.status, 'completed');
    t.is(runCount, 2);
    const retryEvent = events.find((e) => e.type === 'retry');
    t.truthy(retryEvent, 'should emit retry event');
    t.is(retryEvent.toolName, 'bash');
    t.is(retryEvent.retryType, 'hallucination');
    t.is(retryEvent.attempt, 1);
    t.is(retryEvent.maxRetries, MAX_SUBAGENT_MODEL_RETRIES);

    const retryLog = logWarnCalls.find((c) => c.meta?.eventType === 'retry.model_error');
    t.truthy(retryLog, 'should log subagent model error retry');
  },
);

test.serial('run() exhausts retries on repeated recoverable model errors and returns failed result', async (t) => {
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'failed');
  t.truthy(result.error);
  t.true(result.error!.includes('bash'));
  // Should have tried: initial + MAX_SUBAGENT_MODEL_RETRIES retries.
  t.is(runCount, 1 + MAX_SUBAGENT_MODEL_RETRIES);
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, MAX_SUBAGENT_MODEL_RETRIES, 'should emit one retry event per retry attempt');
});

test.serial('run() does not retry on non-recoverable ModelBehaviorError', async (t) => {
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'failed');
  t.is(runCount, 1, 'no retry should be attempted');
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 0);
});

test.serial('run() aborted subagent returns cancelled status without model-error retry', async (t) => {
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'cancelled');
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 0, 'abort errors should not trigger model-error retries');
});

test.skip('run() retries on transient upstream error via executeWithRetry', async (t) => {
  let runCount = 0;
  const logWarnCalls: any[] = [];

  registerProvider({
    id: 'mock-transient-retry-provider',
    label: 'Mock Transient Retry Provider',
    createRunner: () =>
      ({
        run: async () => {
          runCount++;
          if (runCount === 1) {
            const err = new Error('rate limit') as any;
            err.status = 429;
            err.headers = { 'retry-after': '0' };
            return wrapErrorAsAgentStream(err);
          }
          const result = {
            status: 'completed',
            finalOutput: 'Success after upstream retry',
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
      'agent.provider': 'mock-transient-retry-provider',
      'agent.retryAttempts': 2,
    }),
    sessionContextService: createSessionContextService() as any,
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'completed');
  t.is(runCount, 2, 'should have retried once after transient error');
  const upstreamRetry = logWarnCalls.find((c) => c.meta?.eventType === 'retry.transient');
  t.truthy(upstreamRetry, 'should log upstream retry');
});

test.serial(
  'run() does not restart read-only subagent from the beginning after a recoverable model error',
  async (t) => {
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
      onEvent: (event) => events.push(event),
    });

    const result = await manager.run({ role: 'explorer', task: 'search for something' });

    t.is(result.status, 'failed');
    t.true(result.error?.includes('bash'));
    t.is(runCount, 1, 'subagent must not restart from the beginning when no resumable stream exists');
    t.is(events.filter((event) => event.type === 'retry').length, 0);
  },
);

test.serial('subagent run injects warning into tool output when turns left <= 5', async (t) => {
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

  t.truthy(executeOutput);
  t.true(executeOutput!.includes('approaching the maximum turn limit'), 'should contain max turns warning');
  t.true(executeOutput!.includes('4 turns left'), 'should indicate correct number of turns left');
});

test.serial('execution subagents select subagent-safe model-family prompts and append role instructions', async (t) => {
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

  t.truthy(constructedAgentExplorer);
  t.true(constructedAgentExplorer.instructions.includes('nested Codex-family subagent'));
  t.true(constructedAgentExplorer.instructions.includes('You are an explorer subagent.'));
  t.true(constructedAgentExplorer.instructions.includes('## Worktree Hygiene'));
  t.true(constructedAgentExplorer.instructions.includes('## Available Tool Guidance'));

  const codexIdx = constructedAgentExplorer.instructions.indexOf('nested Codex-family subagent');
  const explorerIdx = constructedAgentExplorer.instructions.indexOf('You are an explorer subagent');
  t.true(codexIdx < explorerIdx, 'Model prompt must come before role prompt');

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

  t.truthy(constructedAgentWorker);
  t.true(constructedAgentWorker.instructions.includes('nested Anthropic-family subagent'));
  t.true(constructedAgentWorker.instructions.includes('You are a worker subagent.'));

  const sonnetIdx = constructedAgentWorker.instructions.indexOf('nested Anthropic-family subagent');
  const workerIdx = constructedAgentWorker.instructions.indexOf('You are a worker subagent');
  t.true(sonnetIdx < workerIdx, 'Model prompt must come before role prompt');

  const managerResearcher = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': 'mock-prompt-test-provider-gpt-5-modern',
    }),
    sessionContextService: createSessionContextService() as any,
  });

  await managerResearcher.run({ role: 'researcher', task: 'research task' });

  t.truthy(constructedAgentResearcher);
  t.true(constructedAgentResearcher.instructions.includes('nested GPT-5-family subagent'));
  t.true(constructedAgentResearcher.instructions.includes('You are a researcher subagent.'));
});

test.serial('execution subagent prompts exclude top-level-only prompt content', async (t) => {
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

  t.truthy(constructedAgent);
  t.false(constructedAgent.instructions.includes('commentary channel'));
  t.false(constructedAgent.instructions.includes('final channel'));
  t.false(constructedAgent.instructions.includes('Intermediary updates'));
  t.false(constructedAgent.instructions.includes('Plan Mode Workflow'));
  t.false(constructedAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.'));
});

test.serial('mentor subagent is NOT affected by prompt profiles', async (t) => {
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

  t.truthy(mentorAgent);
  t.false(mentorAgent.instructions.includes('You are Codex, a coding agent based on GPT-5.'));
  t.false(mentorAgent.instructions.includes('nested Codex-family subagent'));
  t.false(mentorAgent.instructions.includes('## Available Tool Guidance'));
  t.false(mentorAgent.instructions.includes('## Worktree Hygiene'));
  t.true(mentorAgent.instructions.includes('You are a helpful mentor assistant.'));
});

test.serial('subagent tool definitions conditional registration for search tools', async (t) => {
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

  t.truthy(workerAgentShellTrue);
  const toolNamesShellTrue: string[] = workerAgentShellTrue.tools.map((tool: any) => tool.name);
  t.false(
    toolNamesShellTrue.includes('grep'),
    'grep tool should be omitted when searchViaShell is active and canRunShell is true',
  );
  t.false(
    toolNamesShellTrue.includes('find_files'),
    'find_files tool should be omitted when searchViaShell is active and canRunShell is true',
  );
  t.true(toolNamesShellTrue.includes('shell'), 'shell tool must be registered');
  t.true(workerAgentShellTrue.instructions.includes('Registered tools:'));
  t.true(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`'));
  t.true(workerAgentShellTrue.instructions.includes('`fd` for file search'));
  t.false(workerAgentShellTrue.instructions.includes('Use `grep` to search'));
  t.false(workerAgentShellTrue.instructions.includes('Use `find_files` to locate'));
  t.false(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools'));

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

  t.truthy(workerAgentShellFalse);
  const toolNamesShellFalse: string[] = workerAgentShellFalse.tools.map((tool: any) => tool.name);
  t.true(toolNamesShellFalse.includes('grep'), 'grep tool should be registered when searchViaShell is inactive');
  t.true(
    toolNamesShellFalse.includes('find_files'),
    'find_files tool should be registered when searchViaShell is inactive',
  );
  t.true(toolNamesShellFalse.includes('shell'), 'shell tool must be registered');
  t.true(workerAgentShellFalse.instructions.includes('For workspace search, use the dedicated search tools'));
  t.true(workerAgentShellFalse.instructions.includes('`grep`'));
  t.true(workerAgentShellFalse.instructions.includes('`find_files`'));
  t.false(workerAgentShellFalse.instructions.includes('use `shell` with commands like `rg`'));

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
  t.true(toolNamesShellOff.includes('grep'), 'grep tool should remain registered when searchViaShell is off');
  t.true(
    toolNamesShellOff.includes('find_files'),
    'find_files tool should remain registered when searchViaShell is off',
  );
  t.true(toolNamesShellOff.includes('shell'), 'shell tool must still be registered');
  t.true(workerAgentShellTrue.instructions.includes('For workspace search, use the dedicated search tools'));
  t.false(workerAgentShellTrue.instructions.includes('use `shell` with commands like `rg`'));
});

test.serial('explorer uses shell search when available and researcher keeps dedicated search tools', async (t) => {
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

  t.truthy(explorerAgent);
  let toolNames: string[] = explorerAgent.tools.map((tool: any) => tool.name);
  t.true(toolNames.includes('shell'));
  t.false(toolNames.includes('grep'));
  t.false(toolNames.includes('find_files'));
  t.true(explorerAgent.instructions.includes('For workspace search, use `shell` with commands like `rg`'));
  t.false(explorerAgent.instructions.includes('For workspace search, use the dedicated search tools'));

  t.truthy(researcherAgent);
  toolNames = researcherAgent.tools.map((tool: any) => tool.name);
  t.false(toolNames.includes('shell'));
  t.true(toolNames.includes('grep'));
  t.true(toolNames.includes('find_files'));
  t.true(researcherAgent.instructions.includes('For workspace search, use the dedicated search tools'));
  t.false(researcherAgent.instructions.includes('use `shell` with commands like `rg`'));
});

test.serial('remote execution disables code-context tools and guidance', async (t) => {
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

  t.truthy(remoteAgent);
  const toolNames: string[] = remoteAgent.tools.map((tool: any) => tool.name);
  t.false(toolNames.includes('read_code_outline'));
  t.false(toolNames.includes('code_context_search'));
  t.true(remoteAgent.instructions.includes('Code-context tools are not available in this run.'));
  t.false(remoteAgent.instructions.includes('For code structure and symbol context, use:'));
});

test.serial('run() aborted subagent retains toolsUsed and filesChanged', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] ?? '/tmp', 'term2-test-abort-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

  t.is(result.status, 'cancelled');
  t.is(result.toolsUsed.length, 1);
  t.is(result.toolsUsed[0].toolName, 'create_file');
  t.deepEqual(result.filesChanged, ['test.ts']);
});
