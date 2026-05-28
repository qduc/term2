import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import { ModelBehaviorError } from '@openai/agents';
import { SubagentManager } from './subagent-manager.js';
import { registerProvider } from '../../providers/registry.js';
import { ExecutionContext } from '../execution-context.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';

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

// ========== Provider Mocks ==========

let mentorManagerRunnerCalls: any[] = [];
let mentorManagerResponseCounter = 0;
let mentorManagerProviderRegistered = false;

function ensureMentorManagerProviderRegistered() {
  if (!mentorManagerProviderRegistered) {
    registerProvider({
      id: 'mock-mentor-manager',
      label: 'Mock Mentor Manager',
      createRunner: () =>
        ({
          run: async (_agent: any, _input: any, _options: any) => {
            mentorManagerRunnerCalls.push({ input: _input, options: _options, agent: _agent });
            mentorManagerResponseCounter++;
            return {
              status: 'completed',
              finalOutput: `mentor-response-${mentorManagerResponseCounter}`,
              responseId: `resp-${mentorManagerResponseCounter}`,
              history: [],
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    mentorManagerProviderRegistered = true;
  }
}

let explorerManagerProviderRegistered = false;
let explorerRunnerCalls: any[] = [];

function ensureExplorerProviderRegistered() {
  if (!explorerManagerProviderRegistered) {
    registerProvider({
      id: 'mock-explorer-provider',
      label: 'Mock Explorer Provider',
      createRunner: () =>
        ({
          run: async (_agent: any, input: any, options: any) => {
            explorerRunnerCalls.push({ input, agent: _agent, options });
            return {
              status: 'completed',
              finalOutput: 'Found the relevant files.',
              history: [],
              messages: [],
            };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
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
    'agent.model': 'mock-model',
    'agent.provider': 'mock-mentor-manager',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'nonexistent-role-xyz', task: 'do something' });

  t.is(result.status, 'failed');
  t.truthy(result.error);
  t.true(result.error!.includes('nonexistent-role-xyz'));
});

// ========== Mentor role ==========

test.serial('run() with mentor role uses mentorModel setting', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': 'mock-mentor-manager',
    'agent.mentorModel': 'mentor-model',
    'agent.mentorProvider': 'mock-mentor-manager',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'mentor', task: 'advise me' });

  t.is(result.status, 'completed');
  t.is(result.role, 'mentor');
  t.true(result.finalText.includes('mentor-response'));
  t.is(mentorManagerRunnerCalls.length, 1);
  t.is(mentorManagerRunnerCalls[0].agent.model, 'mentor-model');
});

test.serial('run() with mentor role fails when mentorModel is not set', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': 'mock-mentor-manager',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'mentor', task: 'advise me' });

  t.is(result.status, 'failed');
  t.true(result.error!.includes('Mentor model is not configured'));
});

test.serial('run() mentor maintains conversation history across calls', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': 'mock-mentor-manager',
    'agent.mentorModel': 'mentor-model',
    'agent.mentorProvider': 'mock-mentor-manager',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  await manager.run({ role: 'mentor', task: 'first question' });
  await manager.run({ role: 'mentor', task: 'second question' });

  t.is(mentorManagerRunnerCalls.length, 2);
  // Second call should have history (array with previous messages)
  t.true(Array.isArray(mentorManagerRunnerCalls[1].input));
  t.true(mentorManagerRunnerCalls[1].input.length > 1);
});

test.serial('resetMentorSession() clears conversation history', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'main-model',
    'agent.provider': 'mock-mentor-manager',
    'agent.mentorModel': 'mentor-model',
    'agent.mentorProvider': 'mock-mentor-manager',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  await manager.run({ role: 'mentor', task: 'first question' });
  t.true(mentorManagerRunnerCalls[0].input.length >= 1);

  manager.resetMentorSession();

  await manager.run({ role: 'mentor', task: 'fresh question' });
  // After reset, second call should have only 1 message (fresh start)
  t.is(mentorManagerRunnerCalls[1].input.length, 1);
});

// ========== Explorer role ==========

test.serial('run() with explorer role returns SubagentResult', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-explorer-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  const result = await manager.run({ role: 'explorer', task: 'find all TypeScript files' });

  t.is(result.status, 'completed');
  t.is(result.role, 'explorer');
  t.truthy(result.agentId);
  t.is(result.filesChanged.length, 0);
  t.truthy(result.finalText);
});

test.serial('run() passes parent abort signal into the delegated provider run', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-explorer-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });
  const abortController = new AbortController();

  await manager.run({
    role: 'explorer',
    task: 'find all TypeScript files',
    signal: abortController.signal,
  });

  t.is(explorerRunnerCalls[0].options.signal, abortController.signal);
});

test.serial('run() cancels a delegated provider run when the parent signal aborts', async (t) => {
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
    'agent.model': 'mock-model',
    'agent.provider': 'mock-aborted-subagent-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });
  const abortController = new AbortController();
  const resultPromise = manager.run({
    role: 'explorer',
    task: 'find all TypeScript files',
    signal: abortController.signal,
  });

  queueMicrotask(() => abortController.abort());
  const result = await resultPromise;

  t.is(result.status, 'cancelled');
  t.true(result.error?.includes('aborted') ?? false);
});

test.serial('run() with explorer role uses read-only tools only', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-explorer-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  await manager.run({ role: 'explorer', task: 'find files' });

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
  t.false(toolNames.includes('shell'));
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
            return {
              status: 'completed',
              finalOutput: 'Research findings.',
              history: [],
              messages: [],
            };
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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

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
            return {
              status: 'completed',
              finalOutput: 'Changes applied.',
              history: [],
              messages: [],
            };
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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

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
            return {
              status: 'completed',
              finalOutput: 'Done.',
              history: [],
              messages: [],
            };
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

          return {
            status: 'completed',
            finalOutput: 'Done.',
            history: [],
            messages: [],
          };
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

          return {
            status: 'completed',
            finalOutput: JSON.stringify({ first, second }),
            history: [],
            messages: [],
          };
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
            return { status: 'completed', finalOutput: 'done', history: [], messages: [] };
          },
        } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    });
    eventToolProviderRegistered = true;
  }
}

test.serial('run() emits started, tool_started and completed events', async (t) => {
  ensureEventToolProviderRegistered();
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-event-tool-provider',
  });
  const events: any[] = [];
  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings,
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'search the code' });

  const started = events.find((e) => e.type === 'subagent_started');
  t.truthy(started);
  t.is(started.role, 'explorer');
  t.is(started.task, 'search the code');
  t.is(started.agentId, result.agentId);

  const toolStarted = events.find((e) => e.type === 'subagent_tool_started');
  t.truthy(toolStarted);
  t.is(toolStarted.toolName, 'read_file');
  t.is(toolStarted.agentId, result.agentId);
  t.is(toolStarted.commandMessages?.[0]?.command, 'read_file "/nonexistent-subagent-event-test"');

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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

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
          run: async () => ({
            status: 'completed',
            // finalOutput intentionally absent to exercise the history fallback.
            history: [
              { rawItem: { role: 'assistant', content: 'Let me look into this first.' } },
              { rawItem: { type: 'function_call', name: 'grep' } },
              { rawItem: { type: 'function_call_result', name: 'grep' } },
              { rawItem: { role: 'assistant', content: 'Final answer: it is in foo.ts.' } },
            ],
            messages: [],
          }),
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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

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
        run: async (agent: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          // needsApproval must be false for safe commands — no approval UI in workers
          const needsApproval = await shellTool.needsApproval({}, { command: 'ls .' });
          t.is(needsApproval, false, 'worker shell tool must never require approval');

          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'echo hello' }), {});
          return {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
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
        run: async (agent: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          // needsApproval must always be false — dangerous commands are blocked by execute(), not approval
          const needsApproval = await shellTool.needsApproval({}, { command: 'rm -rf /tmp/something' });
          t.is(needsApproval, false, 'worker shell must never trigger approval UI even for dangerous commands');

          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'rm -rf /tmp/something' }), {});
          return {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
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
        run: async (agent: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
          return {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
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
        run: async (agent: any) => {
          const shellTool = agent.tools.find((tool: any) => tool.name === 'shell');
          shellResult = await shellTool.invoke({}, JSON.stringify({ command: 'npm run test:verbose -- --help' }), {});
          return {
            status: 'completed',
            finalOutput: 'done',
            history: [],
            messages: [],
          };
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
  const manager = new SubagentManager({ logger: createMockLogger(), settings });
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
              throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
            }
            return {
              status: 'completed',
              finalOutput: 'Success on retry',
              history: [],
              messages: [],
            };
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
    t.is(retryEvent.maxRetries, 1);

    const retryLog = logWarnCalls.find((c) => c.meta?.eventType === 'retry.subagent_model_error');
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
          throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'failed');
  t.truthy(result.error);
  t.true(result.error!.includes('bash'));
  // Should have tried: initial + MAX_SUBAGENT_MODEL_RETRIES (1) = 2 attempts
  t.is(runCount, 2);
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 1, 'should emit one retry event before exhaustion');
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
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'cancelled');
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 0, 'abort errors should not trigger model-error retries');
});

test.serial('run() retries on transient upstream error via executeWithRetry', async (t) => {
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
            throw err;
          }
          return {
            status: 'completed',
            finalOutput: 'Success after upstream retry',
            history: [],
            messages: [],
          };
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
  });

  const result = await manager.run({ role: 'explorer', task: 'find all files' });

  t.is(result.status, 'completed');
  t.is(runCount, 2, 'should have retried once after transient error');
  const upstreamRetry = logWarnCalls.find((c) => c.meta?.eventType === 'retry.upstream');
  t.truthy(upstreamRetry, 'should log upstream retry');
});

test.serial('run() does not retry worker after a mutating write tool was invoked before the model error', async (t) => {
  let runCount = 0;
  const events: any[] = [];

  registerProvider({
    id: 'mock-write-then-crash-provider',
    label: 'Mock Write Then Crash Provider',
    createRunner: () =>
      ({
        run: async (agent: any) => {
          runCount++;
          // Invoke a write tool before crashing with a recoverable model error
          const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
          if (createFile) {
            await createFile.invoke({}, JSON.stringify({ path: 'touched.ts', content: 'x' }), {});
          }
          throw new ModelBehaviorError('Tool bash not found in agent Worker.');
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-write-then-crash-'));
  t.teardown(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-write-then-crash-provider',
      'agent.retryAttempts': 2,
    }),
    executionContext: {
      getCwd: () => tmpDir,
      isRemote: () => false,
      getSSHService: () => undefined,
    } as unknown as ExecutionContext,
    onEvent: (event) => events.push(event),
  });

  const result = await manager.run({ role: 'worker', task: 'do some work' });

  t.is(result.status, 'failed');
  t.is(runCount, 1, 'must not retry when a write tool was invoked before the model error');
  const retryEvents = events.filter((e) => e.type === 'retry');
  t.is(retryEvents.length, 0, 'no retry event should be emitted');
});

test.serial('run() retries read-only subagent (explorer) even after read tools were called', async (t) => {
  let runCount = 0;

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
          return { status: 'completed', finalOutput: 'found it', history: [], messages: [] };
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
  });

  const result = await manager.run({ role: 'explorer', task: 'search for something' });

  t.is(result.status, 'completed');
  t.is(runCount, 2, 'read-only subagent should retry even after read tools ran');
});

test.serial('corrective retry task for hallucination names the specific bad tool', async (t) => {
  const runInputs: string[] = [];

  registerProvider({
    id: 'mock-corrective-hallucination-provider',
    label: 'Mock Corrective Hallucination Provider',
    createRunner: () =>
      ({
        run: async (_agent: any, input: any) => {
          const inputText = typeof input === 'string' ? input : JSON.stringify(input);
          runInputs.push(inputText);
          if (runInputs.length === 1) {
            throw new ModelBehaviorError('Tool bash not found in agent Explorer.');
          }
          return { status: 'completed', finalOutput: 'done', history: [], messages: [] };
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-corrective-hallucination-provider',
      'agent.retryAttempts': 2,
    }),
  });

  await manager.run({ role: 'explorer', task: 'do something' });

  t.is(runInputs.length, 2);
  const retryInput = runInputs[1];
  t.true(retryInput.includes('"bash"'), 'corrective prompt should name the hallucinated tool');
  t.true(retryInput.includes('does not exist'), 'corrective prompt should say the tool does not exist');
});

test.serial('corrective retry task for behavior error instructs model to produce a final answer', async (t) => {
  const runInputs: string[] = [];

  registerProvider({
    id: 'mock-corrective-behavior-provider',
    label: 'Mock Corrective Behavior Provider',
    createRunner: () =>
      ({
        run: async (_agent: any, input: any) => {
          const inputText = typeof input === 'string' ? input : JSON.stringify(input);
          runInputs.push(inputText);
          if (runInputs.length === 1) {
            throw new ModelBehaviorError('Model did not produce a final response');
          }
          return { status: 'completed', finalOutput: 'done', history: [], messages: [] };
        },
      } as any),
    fetchModels: async () => [{ id: 'mock-model' }],
  });

  const manager = new SubagentManager({
    logger: createMockLogger(),
    settings: createMockSettings({
      'agent.model': 'mock-model',
      'agent.provider': 'mock-corrective-behavior-provider',
      'agent.retryAttempts': 2,
    }),
  });

  await manager.run({ role: 'explorer', task: 'do something' });

  t.is(runInputs.length, 2);
  const retryInput = runInputs[1];
  t.true(retryInput.includes('final'), 'corrective prompt for behavior should instruct to produce a final answer');
  t.true(retryInput.includes('Do not call'), 'should tell model not to call more tools');
});
