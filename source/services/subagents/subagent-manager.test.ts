import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
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
          run: async (_agent: any, input: any, _options: any) => {
            explorerRunnerCalls.push({ input, agent: _agent });
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

test.serial('run() with worker role includes write tools', async (t) => {
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-worker-provider',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  await manager.run({ role: 'worker', task: 'update the README.md file' });

  t.is(workerRunnerCalls.length, 1);
  const agent = workerRunnerCalls[0].agent;
  const toolNames: string[] = agent.tools.map((t: any) => t.name);

  // Worker should have read AND write tools
  t.true(toolNames.includes('read_file'));
  t.true(toolNames.includes('apply_patch'));
  t.true(toolNames.includes('search_replace'));
  t.true(toolNames.includes('create_file'));

  // But not web or shell
  t.false(toolNames.includes('web_search'));
  t.false(toolNames.includes('shell'));
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

test.serial('worker write tool rejects paths outside writeBoundary', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'term2-test-boundary-'));
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

  await manager.run({
    role: 'worker',
    task: 'update a file',
    writeBoundary: ['.'],
  });

  t.is(boundaryWorkerCalls.length, 1);
  const agent = boundaryWorkerCalls[0].agent;
  const applyPatch = agent.tools.find((t: any) => t.name === 'apply_patch');
  const searchReplace = agent.tools.find((t: any) => t.name === 'search_replace');
  t.truthy(applyPatch);
  t.truthy(searchReplace);

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

  // Batch search_replace: all replacement paths must be boundary-checked
  const batchOutsideResult = await searchReplace.invoke(
    {},
    JSON.stringify({
      replacements: [
        {
          path: 'inside.ts',
          search_content: '',
          replace_content: 'ok',
        },
        {
          path: '../outside.ts',
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

test.serial('worker in-boundary write is auto-approved (boundary is the grant)', async (t) => {
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
    writeBoundary: ['.'],
  });

  t.is(boundaryWorkerCalls.length, 1);
  const agent = boundaryWorkerCalls[0].agent;
  const createFile = agent.tools.find((tool: any) => tool.name === 'create_file');
  t.truthy(createFile);

  // The writeBoundary is the worker's permission grant: an in-boundary write
  // requires no interactive approval (there is no foreground approval channel
  // for a subagent running inside a blocked parent tool call). Edit mode is off
  // but the write still does not need approval.
  const inBoundaryNeedsApproval = await createFile.needsApproval({}, { path: 'a.ts', content: 'x' });
  t.is(inBoundaryNeedsApproval, false);

  // Out-of-boundary writes are also not surfaced for approval; they are
  // rejected deterministically by execute() instead.
  const outBoundaryNeedsApproval = await createFile.needsApproval({}, { path: '../escape.ts', content: 'x' });
  t.is(outBoundaryNeedsApproval, false);
});

test.serial('worker without explicit writeBoundary cannot write outside the workspace', async (t) => {
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

  // No writeBoundary passed -> defaults to the workspace root.
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

          await searchReplace.invoke(
            {},
            JSON.stringify({
              replacements: [
                { path: 'b.txt', search_content: '', replace_content: 'created' },
                { path: 'missing2.txt', search_content: 'x', replace_content: 'y' },
              ],
            }),
            {},
          );

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

  const manager = new SubagentManager({
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

  const result = await manager.run({ role: 'worker', task: 'do mixed writes' });

  t.deepEqual(new Set(result.filesChanged), new Set(['a.txt', 'b.txt']));
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
  // Body text defined in source/prompts/subagents/mentor.md
  t.true(instructions.includes('helpful mentor assistant'));
  t.true(instructions.includes('no direct workspace access'));
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
