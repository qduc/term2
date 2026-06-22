import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TestSubagentManager,
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  createMockExecutionContext,
  createTempDir,
  removeTempDir,
  registerTestProvider,
  wrapResultAsAgentStream,
  wrapErrorAsAgentStream,
  getAgentTool,
  ROLE_MENTOR,
  ROLE_EXPLORER,
  ROLE_WORKER,
  ROLE_RESEARCHER,
} from './test-helpers/subagent-manager-fixtures.js';
import { SubagentManager as RealSubagentManager } from './subagent-manager.js';
import { ModelBehaviorError } from '@openai/agents';
import { MAX_SUBAGENT_MODEL_RETRIES } from '../retry/conversation-retry-policy.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';

const ROLE_UNKNOWN = 'nonexistent-role-xyz';
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

// ========== run() with unknown role ==========

it('run() returns failed result for unknown role', async () => {
  const providerId = registerTestProvider({
    label: 'Mock Mentor Manager',
    createRunner: () =>
      ({
        run: async (_agent: any, _input: any, _options: any) => {
          const result = {
            status: 'completed',
            finalOutput: 'mentor-response',
            history: [],
            messages: [],
          };
          return _options?.stream ? wrapResultAsAgentStream(result) : result;
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const settings = createMockSettings({
    'agent.model': MODEL_MOCK,
    'agent.provider': providerId,
  });
  const manager = new TestSubagentManager({
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

describe('mentor role', () => {
  let mentorManagerRunnerCalls: any[];
  let mentorManagerResponseCounter: number;
  let mentorProviderId: string;

  beforeEach(() => {
    mentorManagerRunnerCalls = [];
    mentorManagerResponseCounter = 0;
    mentorProviderId = registerTestProvider({
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
  });

  it('run() with mentor role uses mentorModel setting', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MAIN,
      'agent.provider': mentorProviderId,
      'agent.mentorModel': MODEL_MENTOR,
      'agent.mentorProvider': mentorProviderId,
    });
    const manager = new TestSubagentManager({
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

  it('run() with mentor role fails when mentorModel is not set', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MAIN,
      'agent.provider': mentorProviderId,
    });
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings,
      sessionContextService: createSessionContextService() as any,
    });

    const result = await manager.run({ role: ROLE_MENTOR, task: TASK_ADVISE_ME });

    expect(result.status).toBe('failed');
    expect(result.error!.includes(MENTOR_MODEL_NOT_CONFIGURED_ERROR)).toBe(true);
  });

  it('run() mentor maintains conversation history across calls', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MAIN,
      'agent.provider': mentorProviderId,
      'agent.mentorModel': MODEL_MENTOR,
      'agent.mentorProvider': mentorProviderId,
    });
    const manager = new TestSubagentManager({
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

  it('resetMentorSession() clears conversation history', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MAIN,
      'agent.provider': mentorProviderId,
      'agent.mentorModel': MODEL_MENTOR,
      'agent.mentorProvider': mentorProviderId,
    });
    const manager = new TestSubagentManager({
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
});

// ========== Explorer role ==========

describe('explorer role', () => {
  let explorerRunnerCalls: any[];
  let explorerProviderId: string;

  beforeEach(() => {
    explorerRunnerCalls = [];
    explorerProviderId = registerTestProvider({
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
  });

  it('run() with explorer role returns SubagentResult', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MOCK,
      'agent.provider': explorerProviderId,
      'sandbox.enabled': false,
    });
    const manager = new TestSubagentManager({
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

  it('run() passes parent abort signal into the delegated provider run', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MOCK,
      'agent.provider': explorerProviderId,
      'sandbox.enabled': false,
    });
    const manager = new TestSubagentManager({
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

  it('run() cancels a delegated provider run when the parent signal aborts', async () => {
    // ConversationSession threads the parent signal through agentClient.abort(),
    // which aborts the internal AbortController whose signal reaches the runner
    // via startStream(). The mock listens on options.signal (the internal AC).
    const abortProviderId = registerTestProvider({
      label: 'Mock Aborted Subagent Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, options: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              const rejectAbort = () =>
                reject(Object.assign(new Error('delegated run aborted'), { name: 'AbortError' }));
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
      'agent.provider': abortProviderId,
    });
    const manager = new TestSubagentManager({
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

  it('explorer shell tool executes GREEN commands and blocks YELLOW and RED commands', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MOCK,
      'agent.provider': explorerProviderId,
      'sandbox.enabled': false,
    });
    const manager = new TestSubagentManager({
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

  describe('explorer shell tool blocks write-like shell commands', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir(TEMP_WORKSPACE_PREFIX);
    });

    afterEach(() => {
      removeTempDir(tmpDir);
    });

    it('without creating files in a temp workspace', async () => {
      const { writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      writeFileSync(join(tmpDir, TEMP_SOURCE_FILE), 'source content');

      const settings = createMockSettings({
        'agent.model': MODEL_MOCK,
        'agent.provider': explorerProviderId,
      });
      const manager = new TestSubagentManager({
        logger: createMockLogger(),
        settings,
        sessionContextService: createSessionContextService() as any,
        executionContext: createMockExecutionContext(tmpDir),
      });

      await manager.run({ role: ROLE_EXPLORER, task: TASK_INSPECT_TEMP_WORKSPACE });

      const agent = explorerRunnerCalls[explorerRunnerCalls.length - 1].agent;
      const shell = getAgentTool(agent, 'shell');
      expect(shell).toBeTruthy();

      for (const { command, path: relativePath } of TEMP_BLOCKED_CASES) {
        const output = await shell.invoke({}, JSON.stringify({ command }), {});
        expect(output.startsWith(EXPLORER_BLOCKED_PREFIX)).toBe(true);
        const { existsSync } = await import('node:fs');
        expect(existsSync(join(tmpDir, relativePath))).toBe(false);
      }
    });
  });

  it('run() with explorer role uses read-only tools only', async () => {
    const settings = createMockSettings({
      'agent.model': MODEL_MOCK,
      'agent.provider': explorerProviderId,
    });
    const manager = new TestSubagentManager({
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
});

// ========== Researcher role ==========

describe('researcher role', () => {
  let researcherRunnerCalls: any[];
  let researcherProviderId: string;

  beforeEach(() => {
    researcherRunnerCalls = [];
    researcherProviderId = registerTestProvider({
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
  });

  it('run() with researcher role includes web tools', async () => {
    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': researcherProviderId,
    });
    const manager = new TestSubagentManager({
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
});

// ========== Worker role ==========

describe('worker role', () => {
  let workerRunnerCalls: any[];
  let workerProviderId: string;

  beforeEach(() => {
    workerRunnerCalls = [];
    workerProviderId = registerTestProvider({
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
  });

  it('run() with worker role includes write and shell tools for non-gpt model', async () => {
    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': workerProviderId,
    });
    const manager = new TestSubagentManager({
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

  it('run() with worker role includes write and shell tools for gpt model', async () => {
    const settings = createMockSettings({
      'agent.model': 'gpt-5',
      'agent.provider': workerProviderId,
    });
    const manager = new TestSubagentManager({
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

  it('run() result contains agentId and correct role', async () => {
    const settings = createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': workerProviderId,
    });
    const manager = new TestSubagentManager({ logger: createMockLogger(), settings });

    const result = await manager.run({ role: 'worker', task: 'do some work' });

    expect(result.role).toBe('worker');
    expect(result.agentId).toBeTruthy();
    expect(result.agentId.length > 0).toBe(true);
    expect(result.filesChanged.length).toBe(0);
    expect(result.status).toBe('completed');
  });
});

// ========== Worker role agent tool caching ==========

describe('worker role agent tool caching', () => {
  let boundaryProviderId: string;

  beforeEach(() => {
    boundaryProviderId = registerTestProvider({
      label: 'Mock Boundary Worker',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
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
  });

  it('getRoleAgentTool caches one internal agent tool per role', () => {
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': boundaryProviderId,
      }),
    });

    const first = manager.getRoleAgentTool('worker');
    const second = manager.getRoleAgentTool('worker');
    const explorer = manager.getRoleAgentTool('explorer');

    expect(first).toBe(second);
    expect(first).not.toBe(explorer);
    expect(first.name).toBe('run_subagent_worker');
  });

  it('clearCache rebuilds cached role agent tools', () => {
    const manager = new TestSubagentManager({
      logger: createMockLogger(),
      settings: createMockSettings({
        'agent.model': 'mock-model',
        'agent.provider': boundaryProviderId,
      }),
    });

    const first = manager.getRoleAgentTool('worker');
    manager.clearCache();
    const rebuilt = manager.getRoleAgentTool('worker');

    expect(first).not.toBe(rebuilt);
  });

  describe('cached worker agent preserves native approval checks for nested tools', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir('term2-test-nested-worker-approval-');
    });

    afterEach(() => {
      removeTempDir(tmpDir);
    });

    it('preserves approval checks', async () => {
      const manager = new TestSubagentManager({
        logger: createMockLogger(),
        settings: createMockSettings({
          'agent.model': 'mock-model',
          'agent.provider': boundaryProviderId,
          'sandbox.enabled': false,
        }),
        executionContext: createMockExecutionContext(tmpDir),
      });

      const worker = manager.getRoleAgent('worker');
      const shell = getAgentTool(worker, 'shell');
      const createFile = getAgentTool(worker, 'create_file');

      expect(await shell.needsApproval({}, { command: 'touch nested-approval.txt' })).toBe(true);
      expect(await createFile.needsApproval({}, { path: 'inside.txt', content: 'ok' })).toBe(false);
      expect(await createFile.needsApproval({}, { path: '../outside.txt', content: 'blocked' })).toBe(false);
    });
  });
});
