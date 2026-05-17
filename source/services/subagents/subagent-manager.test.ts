import test from 'ava';
import { SubagentManager } from './subagent-manager.js';
import { registerProvider } from '../../providers/registry.js';
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
  const settings = createMockSettings({
    'agent.model': 'mock-model',
    'agent.provider': 'mock-boundary-worker',
  });
  const manager = new SubagentManager({ logger: createMockLogger(), settings });

  await manager.run({
    role: 'worker',
    task: 'update a file',
    writeBoundary: ['src/'],
  });

  t.is(boundaryWorkerCalls.length, 1);
  const agent = boundaryWorkerCalls[0].agent;
  const applyPatch = agent.tools.find((t: any) => t.name === 'apply_patch');
  t.truthy(applyPatch);

  // Call with a path inside the boundary — should NOT be rejected for boundary violation
  const insideResult = await applyPatch.invoke(
    {},
    JSON.stringify({
      type: 'create_file',
      path: 'src/newfile.ts',
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
      path: 'other/file.ts',
      diff: '+hello\n',
    }),
    {},
  );
  const outsideParsed = JSON.parse(outsideResult);
  t.true(outsideParsed?.output?.[0]?.error?.includes('outside the allowed write boundary'));
  t.false(outsideParsed?.output?.[0]?.success ?? true);
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
