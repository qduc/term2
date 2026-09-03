import { it, expect, vi } from 'vitest';
import { getAgentDefinition, getAgentsInstructions, getEnvInfo } from './agent.js';
import { createMockSettingsService } from './services/settings/settings-service.mock.js';
import { ExecutionContext } from './services/execution-context.js';
import type { SubagentResult, SubagentRunHandle, SubagentRunStatus } from './services/subagents/types.js';
import os from 'os';
import { BackgroundShellRegistry } from './services/shell/background-shell-registry.js';
import { SessionBrowser } from './services/conversation/session-browser.js';
import { builtinProfileRegistry, type ProfileDefinition } from './services/profiles/index.js';

// search-via-shell probes `rg` availability with spawnSync while assembling
// the prompt. Tests below pin that probe instead of inheriting whichever
// binaries the host happens to have, so both availability scenarios run
// deterministically everywhere.
const binaryProbeControl = vi.hoisted(() => ({
  mode: 'passthrough' as 'passthrough' | 'present' | 'absent',
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSyncOverride = ((command: any, ...rest: any[]) => {
    if (binaryProbeControl.mode !== 'passthrough' && command === 'rg') {
      return { status: binaryProbeControl.mode === 'present' ? 0 : 1 };
    }
    return (actual.spawnSync as any)(command, ...rest);
  }) as typeof actual.spawnSync;
  return { ...actual, spawnSync: spawnSyncOverride };
});

function setRipgrepAvailability(mode: 'present' | 'absent') {
  binaryProbeControl.mode = mode;
}

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
} as any;

const WORKTREE_HYGIENE_FRAGMENT_MARKER = 'Before making any code changes, inspect the repo worktree.';

const makeSubagentResult = (finalText = 'done'): SubagentResult => ({
  agentId: 'agent-1',
  role: 'worker',
  status: 'completed',
  finalText,
  filesChanged: [],
  toolsUsed: [],
});

const makeSubagentRunHandle = (): SubagentRunHandle => ({
  runId: 'run-1',
  role: 'worker',
  status: 'running',
  task: 'test task',
});

const makeSubagentRunStatus = (): SubagentRunStatus => ({
  runId: 'run-1',
  role: 'worker',
  status: 'completed',
  task: 'test task',
  taskPreview: 'test task',
  startedAt: 0,
  elapsedMs: 0,
  toolCounts: {},
});

const orchestratorSubagentDeps = {
  runSubagentAsync: async () => makeSubagentRunHandle(),
  getSubagentResult: async () => makeSubagentResult(),
  getSubagentStatus: () => makeSubagentRunStatus(),
  sendSubagentMessage: () => ({
    ok: true as const,
    runId: 'run-1',
    status: 'running' as const,
    delivery: 'queued' as const,
  }),
  cancelSubagentRun: () => ({ ok: true as const, runId: 'run-1', status: 'cancelling' as const }),
};

function getToolNames(settings: Record<string, any> = {}, dependencies: Record<string, any> = {}): string[] {
  return getAgentDefinition({
    settingsService: createMockSettingsService(settings),
    loggingService: mockLogger,
    ...dependencies,
  }).tools.map((tool) => tool.name);
}

it('adds memory tools and summary-only context when memory is enabled, and neither when disabled', async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'term2-agent-memory-'));
  try {
    await mkdir(join(root, 'items'));
    await writeFile(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: 'project-rules',
            title: 'Rules',
            summary: 'Durable rules.',
            tags: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const enabled = getAgentDefinition({
      settingsService: createMockSettingsService({ 'memory.directory': root }),
      loggingService: mockLogger,
    });
    const disabled = getAgentDefinition({
      settingsService: createMockSettingsService({ 'memory.enabled': false, 'memory.directory': root }),
      loggingService: mockLogger,
    });
    expect(enabled.tools.map((tool) => tool.name).filter((name) => name.startsWith('memory_'))).toEqual([
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
      'memory_synthesize',
      'memory_create',
      'memory_update',
      'memory_delete',
    ]);
    expect(enabled.instructions).toContain('Durable rules.');
    expect(enabled.instructions).not.toContain('full memory content');
    expect(disabled.tools.map((tool) => tool.name).filter((name) => name.startsWith('memory_'))).toEqual([]);
    expect(disabled.instructions).not.toContain('## Persistent memory');
    expect(disabled.instructions).not.toContain('Durable rules.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('registers prior-session browser tools only when the root composition explicitly supplies one', () => {
  const absent = getAgentDefinition({ settingsService: createMockSettingsService(), loggingService: mockLogger });
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const list = vi.spyOn(browser, 'list').mockReturnValue({
    sessions: [{ firstUserMessage: 'HISTORICAL_TRANSCRIPT_SENTINEL' }],
    scope: '/project',
    total: 1,
    omitted: 0,
    unavailable: 0,
  });
  const present = getAgentDefinition({
    settingsService: createMockSettingsService(),
    loggingService: mockLogger,
    sessionBrowser: browser,
  });
  expect(absent.tools.map((tool) => tool.name)).not.toContain('session_list');
  expect(present.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['session_list', 'session_search', 'session_read']),
  );
  expect(present.instructions).toContain('Prior-session transcripts');
  expect(present.instructions).toContain('`id: "previous"` directly');
  expect(present.instructions).not.toContain('session transcript text');
  expect(present.instructions).not.toContain('HISTORICAL_TRANSCRIPT_SENTINEL');
  expect(list).not.toHaveBeenCalled();
});

it('includes prior-session safety guidance for an interactive orchestrator root', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    sessionBrowser: new SessionBrowser(() => ({ projectPath: '/project' })),
    ...orchestratorSubagentDeps,
  });

  expect(definition.tools.map((tool) => tool.name)).toContain('session_read');
  expect(definition.instructions).toContain('Prior-session transcripts');
  expect(definition.instructions).toContain('stale or untrusted');
});

it('advertises memory synthesis instead of librarian delegation', () => {
  const enabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });
  const disabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true, 'memory.enabled': false }),
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  expect(enabled.instructions).not.toContain('`librarian`');
  expect(enabled.instructions).toContain('Use memory_synthesize when the task depends on several memories');
  expect(disabled.instructions).not.toContain('`librarian`');
});

it('starts without injected memory context and warns when the memory index is corrupted', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'term2-agent-memory-corrupt-'));
  try {
    await writeFile(join(root, 'index.json'), '{ malformed');

    const warn = vi.fn();
    const definition = getAgentDefinition({
      settingsService: createMockSettingsService({ 'memory.directory': root }),
      loggingService: { ...mockLogger, warn },
    });

    expect(definition.tools.map((tool) => tool.name)).toContain('memory_search');
    expect(definition.instructions).not.toContain('The following memories are summaries');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/memory context.*corrupted/i));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('registers run_agent_workflow only when enable_agent_workflow is enabled', () => {
  const disabled = getAgentDefinition({
    settingsService: createMockSettingsService({ enable_agent_workflow: false }),
    loggingService: mockLogger,
    agentRuntime: { agent: () => ({}) } as any,
  });
  const enabled = getAgentDefinition({
    settingsService: createMockSettingsService({ enable_agent_workflow: true }),
    loggingService: mockLogger,
    agentRuntime: { agent: () => ({}) } as any,
  });
  expect(disabled.tools.map((tool) => tool.name)).not.toContain('run_agent_workflow');
  expect(enabled.tools.map((tool) => tool.name)).toContain('run_agent_workflow');
});

it('leaves run_subagent and ask_mentor available when workflow feature is disabled', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({
      enable_agent_workflow: false,
      'agent.smartModel': 'gpt-4o-mini',
    }),
    loggingService: mockLogger,
    askMentor: async () => 'mentor',
    runSubagent: async () => makeSubagentResult('subagent'),
    agentRuntime: { agent: () => ({}) } as any,
  });
  const names = definition.tools.map((tool) => tool.name);
  expect(names).toContain('ask_mentor');
  expect(names).toContain('run_subagent');
  expect(names).not.toContain('run_agent_workflow');
});

it('uses configured workflow limits without exposing them in tool arguments', async () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ enable_agent_workflow: true, 'agentWorkflow.maxRuns': 1 }),
    loggingService: mockLogger,
    agentRuntime: { agent: () => ({ run: async () => ({ status: 'completed', output: 'ok' }) }) } as any,
  });
  const workflow = definition.tools.find((tool) => tool.name === 'run_agent_workflow')!;
  expect(Object.keys((workflow.parameters as any).shape)).toEqual(['code']);
  const output = await workflow.execute({
    code: "const agentHandle = agent({ instructions: 'x' }); await agentHandle.run({ task: 'one' }); return agentHandle.run({ task: 'two' });",
  });
  if (typeof output !== 'string') throw new Error('run_agent_workflow must return text');
  const result = JSON.parse(output);
  expect(result).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
});

it('keeps standard and lite tool names identical with bare dependencies', () => {
  const standard = getToolNames({ 'agent.model': 'gpt-4o' });
  const lite = getToolNames({ 'agent.model': 'gpt-4o', 'app.liteMode': true });

  expect([...standard].sort()).toEqual([...lite].sort());
  expect(standard).toEqual(
    expect.arrayContaining([
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
      'memory_synthesize',
      'memory_create',
      'memory_update',
      'memory_delete',
      'read_code_outline',
      'code_context_search',
      'read_file',
      'grep',
      'glob',
      'create_file',
      'search_replace',
    ]),
  );
  expect(standard).not.toEqual(expect.arrayContaining(['ask_mentor', 'run_subagent', 'ask_user']));
});

it('gates mentor and subagent tools on resolved capabilities while retaining ask_user', () => {
  const fullDeps = {
    askMentor: async () => 'mentor',
    runSubagent: async () => makeSubagentResult('subagent'),
    getAskUserAnswer: () => 'answer',
    ...orchestratorSubagentDeps,
  };
  const standard = getToolNames({ 'agent.model': 'gpt-4o', 'agent.smartModel': 'gpt-4o' }, fullDeps);
  const lite = getToolNames({ 'agent.model': 'gpt-4o', 'agent.smartModel': 'gpt-4o', 'app.liteMode': true }, fullDeps);
  const delegatedTools = [
    'ask_mentor',
    'run_subagent',
    'get_subagent_result',
    'get_subagent_status',
    'send_message',
    'cancel_run',
  ];

  expect(standard).toEqual(expect.arrayContaining(delegatedTools));
  expect(standard).toContain('ask_user');
  expect(lite).toContain('ask_user');
  expect(lite).not.toEqual(expect.arrayContaining(delegatedTools));
  expect(standard.filter((name) => !delegatedTools.includes(name)).sort()).toEqual([...lite].sort());
});

it('exposes only the tool groups selected by the resolved Profile', () => {
  const profileId = 'builtin:agent-tools-test';
  const profile: ProfileDefinition = {
    schemaVersion: 1,
    id: 'agent-tools-test',
    version: '1.0.0',
    name: 'Agent tools test',
    blocks: { tools: { kind: 'tools', include: ['shell'] } },
  };
  const profiles = builtinProfileRegistry.profiles as Map<string, ProfileDefinition>;
  const previous = profiles.get(profileId);
  profiles.set(profileId, profile);

  try {
    const names = getToolNames(
      {
        'agent.model': 'gpt-4o',
        'app.activeProfileId': profileId,
        enable_agent_workflow: true,
      },
      {
        askMentor: async () => 'mentor',
        getAskUserAnswer: () => 'answer',
        agentRuntime: { agent: () => ({}) },
        backgroundShellRegistry: new BackgroundShellRegistry<any>(),
        sessionBrowser: new SessionBrowser(() => ({ projectPath: '/project' })),
        ...orchestratorSubagentDeps,
      },
    );

    expect(names).toEqual(['shell']);
  } finally {
    if (previous) profiles.set(profileId, previous);
    else profiles.delete(profileId);
  }
});

it('uses the patch editing surface for gpt-5 in standard and lite modes', () => {
  for (const liteMode of [false, true]) {
    const names = getToolNames({ 'agent.model': 'gpt-5', ...(liteMode ? { 'app.liteMode': true } : {}) });

    expect(names).toContain('apply_patch');
    expect(names).not.toEqual(expect.arrayContaining(['grep', 'glob', 'create_file', 'search_replace']));
  }
});

it('omits dedicated search tools in standard and lite modes when searchViaShell is on', () => {
  for (const liteMode of [false, true]) {
    const names = getToolNames({
      'agent.model': 'gpt-4o',
      'app.searchViaShell': 'on',
      ...(liteMode ? { 'app.liteMode': true } : {}),
    });

    expect(names).not.toEqual(expect.arrayContaining(['grep', 'glob']));
  }
});

it('omits code-context tools in standard and lite modes for remote execution', () => {
  for (const liteMode of [false, true]) {
    const names = getToolNames(
      { 'agent.model': 'gpt-4o', ...(liteMode ? { 'app.liteMode': true } : {}) },
      { executionContext: new ExecutionContext({ isRemote: () => true } as any, '/remote') },
    );

    expect(names).not.toEqual(expect.arrayContaining(['read_code_outline', 'code_context_search']));
  }
});

it('keeps plan, mentor, and orchestrator tool surfaces equal to standard', () => {
  const fullDeps = {
    askMentor: async () => 'mentor',
    runSubagent: async () => makeSubagentResult('subagent'),
    getAskUserAnswer: () => 'answer',
    ...orchestratorSubagentDeps,
  };
  const standard = getToolNames({ 'agent.model': 'gpt-4o', 'agent.smartModel': 'gpt-4o' }, fullDeps);

  for (const mode of ['app.planMode', 'app.mentorMode', 'app.orchestratorMode']) {
    const dependencies = mode === 'app.orchestratorMode' ? { ...fullDeps, ...orchestratorSubagentDeps } : fullDeps;
    const names = getToolNames({ 'agent.model': 'gpt-4o', 'agent.smartModel': 'gpt-4o', [mode]: true }, dependencies);
    expect([...names].sort()).toEqual([...standard].sort());
  }
});

it('getAgentDefinition includes grep and glob when searchViaShell is false', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('glob')).toBe(true);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
});

it('getAgentDefinition includes ask_user in standard mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition includes ask_user in lite mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.liteMode': true }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition allows file modification in lite mode for patch-capable models', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-5', 'app.liteMode': true }),
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames).toContain('apply_patch');
  expect(toolNames).not.toContain('create_file');
  expect(toolNames).not.toContain('search_replace');
  expect(definition.instructions).toContain('edit files');
});

it('getAgentDefinition allows file modification in lite mode for non-patch models', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.liteMode': true }),
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames).toContain('create_file');
  expect(toolNames).toContain('search_replace');
  expect(definition.instructions).toContain('edit files');
});

it('getAgentDefinition includes ask_user in orchestrator mode when getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o', 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
    getAskUserAnswer: () => 'test answer',
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(true);
});

it('getAgentDefinition omits ask_user when getAskUserAnswer is absent', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(false);
});

it('getAgentDefinition omits ask_user when allowAskUser is false even if getAskUserAnswer is provided', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    getAskUserAnswer: () => 'test answer',
    allowAskUser: false,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('ask_user')).toBe(false);
});

it('getAgentDefinition exposes the cache-stable delegation surface in orchestrator mode', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => makeSubagentResult(),
    ...orchestratorSubagentDeps,
  });

  expect(definition.tools.map((tool) => tool.name)).toContain('run_subagent');
  expect(definition.tools.map((tool) => tool.name)).not.toContain('run_subagent_async');
  expect(definition.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['run_subagent', 'get_subagent_result']),
  );
  const subagentTool = definition.tools.find((tool) => tool.name === 'run_subagent');
  const schema = subagentTool?.parameters;
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'background', role: 'explorer', task: 'inspect' }).success,
  ).toBe(true);
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'foreground', role: 'explorer', task: 'inspect' }).success,
  ).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(true);
});

it('getAgentDefinition registers parent async controls in orchestrator and ordinary non-lite async modes', () => {
  const asyncControls = {
    runSubagentAsync: async () => makeSubagentRunHandle(),
    getSubagentResult: async () => makeSubagentResult(),
    getSubagentStatus: () => makeSubagentRunStatus(),
    sendSubagentMessage: () => ({
      ok: true as const,
      runId: 'run-1',
      status: 'running' as const,
      delivery: 'queued' as const,
    }),
    cancelSubagentRun: () => ({ ok: true as const, runId: 'run-1', status: 'cancelling' as const }),
  };
  const orchestrator = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    ...asyncControls,
  });
  const ordinary = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.liteMode': false }),
    loggingService: mockLogger,
    ...asyncControls,
  });

  for (const definition of [orchestrator, ordinary]) {
    expect(definition.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['send_message', 'cancel_run']));
  }
});

it('advertises one background-only delegation tool when standard mode has async execution', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.liteMode': false }),
    loggingService: mockLogger,
    runSubagent: async () => makeSubagentResult(),
    ...orchestratorSubagentDeps,
  });

  const delegationTools = definition.tools.filter((tool) => tool.name === 'run_subagent');
  expect(delegationTools).toHaveLength(1);
  expect(definition.tools.map((tool) => tool.name)).not.toContain('run_subagent_async');
  const schema = delegationTools[0]?.parameters;
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'background', role: 'explorer', task: 'inspect' }).success,
  ).toBe(true);
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'foreground', role: 'explorer', task: 'inspect' }).success,
  ).toBe(false);
});

it('getAgentDefinition registers root background shell controls only with its session registry', () => {
  const registry = new BackgroundShellRegistry<any>();
  const enabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    backgroundShellRegistry: registry,
  });
  const disabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
  });
  const nonInteractive = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    backgroundShellRegistry: registry,
    allowBackgroundShell: false,
  });

  expect(enabled.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['shell', 'get_shell_job', 'cancel_shell_job']),
  );
  expect(disabled.tools.map((tool) => tool.name)).not.toEqual(
    expect.arrayContaining(['get_shell_job', 'cancel_shell_job']),
  );
  expect(nonInteractive.tools.map((tool) => tool.name)).not.toEqual(
    expect.arrayContaining(['get_shell_job', 'cancel_shell_job']),
  );
  expect(enabled.instructions).toContain('### Background shell jobs');
  expect(enabled.instructions).toContain('End the current turn and wait for the automatic completion notification');
  expect(disabled.instructions).not.toContain('### Background shell jobs');
  expect(nonInteractive.instructions).not.toContain('### Background shell jobs');
});

it('getAgentDefinition registers no async delegation tools when the parent controls are absent', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.liteMode': false }),
    loggingService: mockLogger,
    runSubagentAsync: async () => makeSubagentRunHandle(),
    getSubagentResult: async () => makeSubagentResult(),
  });

  // Async delegation is all-or-nothing: a partial callback set must not leave
  // launch tools registered without their guidance or their control channel.
  const toolNames = definition.tools.map((tool) => tool.name);
  for (const name of ['run_subagent_async', 'get_subagent_result', 'send_message', 'cancel_run']) {
    expect(toolNames).not.toContain(name);
  }
  expect(definition.instructions).not.toContain('### Asynchronous subagents');
});

it('does not advertise background execution beside foreground delegation when async controls are incomplete', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.liteMode': false }),
    loggingService: mockLogger,
    runSubagent: async () => makeSubagentResult(),
    runSubagentAsync: async () => makeSubagentRunHandle(),
    getSubagentResult: async () => makeSubagentResult(),
  });

  const schema = definition.tools.find((tool) => tool.name === 'run_subagent')?.parameters;
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'foreground', role: 'explorer', task: 'inspect' }).success,
  ).toBe(true);
  expect(
    schema &&
      'safeParse' in schema &&
      typeof schema.safeParse === 'function' &&
      schema.safeParse({ execution: 'background', role: 'explorer', task: 'inspect' }).success,
  ).toBe(false);
});

it('getAgentDefinition requires parent controls when orchestrator mode enables async delegation', () => {
  expect(() =>
    getAgentDefinition({
      settingsService: createMockSettingsService({ 'app.orchestratorMode': true }),
      loggingService: mockLogger,
      runSubagentAsync: async () => makeSubagentRunHandle(),
      getSubagentResult: async () => makeSubagentResult(),
    }),
  ).toThrow(/sendSubagentMessage.*cancelSubagentRun/);
});

it('getAgentDefinition includes foreground delegation guidance in standard mode when runSubagent is provided', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => makeSubagentResult(),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(true);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(true);
});

it('getAgentDefinition omits delegation guidance when runSubagent is absent', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition omits delegation guidance in lite mode', () => {
  const settingsService = createMockSettingsService({
    'app.liteMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition keeps the orchestrator tool surface cache-stable with standard mode', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  const standard = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-5' }),
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual(standard.tools.map((tool) => tool.name));
  expect(definition.instructions).toBe(standard.instructions);
  expect(definition.instructions).toContain('Validate any memory proposals from subagents');
  expect(definition.tools.map((tool) => tool.name).filter((name) => name.startsWith('memory_'))).toEqual([
    'memory_list',
    'memory_get',
    'memory_search',
    'memory_retrieve',
    'memory_synthesize',
    'memory_create',
    'memory_update',
    'memory_delete',
  ]);
});

it('getAgentDefinition keeps orchestrator behavior in the mode notice, not the prefix', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  expect(definition.instructions.includes('Orchestrator mode')).toBe(false);
  expect(definition.instructions).not.toContain('You own the user-requested outcome end to end');
  expect(definition.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['read_code_outline', 'code_context_search', 'apply_patch']),
  );
});

it('getAgentDefinition in orchestrator mode retains full memory authority for non-gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'run_subagent',
      'get_subagent_result',
      'shell',
      'read_file',
      'grep',
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
      'memory_create',
      'memory_update',
      'memory_delete',
    ]),
  );
});

it('getAgentDefinition keeps search tools stable in orchestrator mode', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('glob')).toBe(true);

  const grepTool = definition.tools.find((tool) => tool.name === 'grep');
  const codeContextTool = definition.tools.find((tool) => tool.name === 'code_context_search');
  expect(grepTool?.description).toContain('use glob');
  expect(grepTool?.description).not.toContain('use shell');
  expect(codeContextTool?.description).toContain('use glob');
  expect(codeContextTool?.description).not.toContain('use shell');
});

it('getAgentDefinition throws if orchestratorMode is true and async delegation is missing', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  expect(() =>
    getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    }),
  ).toThrow(/orchestratorMode.*runSubagentAsync.*getSubagentResult/i);
});

it('getAgentDefinition excludes grep and glob when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
});

it('getAgentDefinition preserves read_file and editing tools when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('search_replace')).toBe(true);
  expect(toolNames.includes('create_file')).toBe(true);
  expect(toolNames.includes('shell')).toBe(true);
});

it('getAgentDefinition excludes grep and glob in lite mode when searchViaShell is true', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'app.liteMode': true,
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('search_replace')).toBe(true);
});

it('getAgentDefinition for gpt-5 omits grep and glob regardless of searchViaShell', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(false);
  expect(toolNames.includes('glob')).toBe(false);
  expect(toolNames.includes('read_code_outline')).toBe(true);
  expect(toolNames.includes('code_context_search')).toBe(true);
  expect(toolNames.includes('read_file')).toBe(true);
  expect(toolNames.includes('apply_patch')).toBe(true);

  const codeContextTool = definition.tools.find((tool) => tool.name === 'code_context_search');
  expect(codeContextTool?.description).toContain('use shell');
  expect(codeContextTool?.description).not.toContain('use glob');
});

it('getAgentDefinition search tools do not reference glob when glob is omitted', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const grepTool = definition.tools.find((tool) => tool.name === 'grep');
  const codeContextTool = definition.tools.find((tool) => tool.name === 'code_context_search');
  expect(grepTool).toBeUndefined();
  expect(codeContextTool?.description).toContain('use shell');
  expect(codeContextTool?.description).not.toContain('use glob');
});

it('getAgentDefinition defaults searchViaShell to true for gpt-5 models when not explicitly configured', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
});

it('getAgentDefinition respects explicitly disabled searchViaShell for gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(false);
});

it('getAgentDefinition does not default searchViaShell to true for non-gpt-5 models', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(false);
  // Dedicated search tool instructions (glob/grep) were removed from the prompt;
  // grep/glob still exist as tools when searchViaShell is false for non-gpt-5.
  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('grep')).toBe(true);
});

it('getAgentDefinition forces searchViaShell on for non-gpt-5 models when explicitly set to on', () => {
  setRipgrepAvailability('present');
  try {
    const settingsService = createMockSettingsService({
      'app.searchViaShell': 'on',
      'agent.model': 'gpt-4o',
    });

    const definition = getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    });

    expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
    expect(definition.instructions.includes('`glob`')).toBe(false);
    expect(definition.instructions.includes('`grep`')).toBe(false);
  } finally {
    binaryProbeControl.mode = 'passthrough';
  }
});

it('getAgentDefinition falls back to naming grep when ripgrep is missing', () => {
  setRipgrepAvailability('absent');
  try {
    const settingsService = createMockSettingsService({
      'app.searchViaShell': 'on',
      'agent.model': 'gpt-4o',
    });

    const definition = getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    });

    expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
    expect(definition.instructions.includes('use `grep`')).toBe(true);
  } finally {
    binaryProbeControl.mode = 'passthrough';
  }
});

// it('getAgentDefinition includes GPT version-specific prompt fragments', () => {
//   const gpt55 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.5-2026-04-23',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt55.instructions.includes('## GPT-5.5 Guidance')).toBe(true);
//   expect(gpt55.instructions.includes('outcome-first behavior')).toBe(true);
//
//   const gpt54 = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt54.instructions.includes('## GPT-5.4 Guidance')).toBe(true);
//   expect(gpt54.instructions.includes('## GPT-5.4 Small-Model Guidance')).toBe(false);
//
//   const gpt54Mini = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.4-mini',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt54Mini.instructions.includes('## GPT-5.4 Guidance')).toBe(true);
//   expect(gpt54Mini.instructions.includes('## GPT-5.4 Small-Model Guidance')).toBe(true);
//
//   const gpt53Codex = getAgentDefinition({
//     settingsService: createMockSettingsService({
//       'agent.model': 'gpt-5.3-codex',
//     }),
//     loggingService: mockLogger,
//   });
//   expect(gpt53Codex.instructions.includes('## GPT-5.3 Codex Guidance')).toBe(true);
// });

it('getAgentDefinition appends search-via-shell addendum when enabled', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes('### Searching via the shell')).toBe(true);
});

it('getAgentDefinition omits dedicated search tool references from prompt when searchViaShell is true', () => {
  setRipgrepAvailability('present');
  try {
    const settingsService = createMockSettingsService({
      'app.searchViaShell': 'on',
      'agent.model': 'gpt-4o',
    });

    const definition = getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    });

    expect(definition.instructions.includes('`glob`')).toBe(false);
    expect(definition.instructions.includes('`grep`')).toBe(false);
  } finally {
    binaryProbeControl.mode = 'passthrough';
  }
});

it('getAgentDefinition uses fallback search prompt for remote execution', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'on',
    'agent.model': 'gpt-4o',
  });

  const mockExecutionContext = {
    isRemote: () => true,
    getCwd: () => '/remote',
    getSSHService: () => ({}),
  } as any;

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    executionContext: mockExecutionContext,
  });

  // Remote should always fallback to grep/find instructions
  expect(definition.instructions.includes('`grep`')).toBe(true);
  expect(definition.instructions.includes('`find`')).toBe(true);
  expect(definition.instructions.includes('`rg`')).toBe(false);
  expect(definition.instructions.includes('`fd`')).toBe(false);
});

it('getAgentDefinition excludes code-context tools in remote (SSH) execution', () => {
  const settingsService = createMockSettingsService({
    'app.searchViaShell': 'off',
    'agent.model': 'gpt-4o',
  });

  const mockExecutionContext = {
    isRemote: () => true,
    getCwd: () => '/remote',
    getSSHService: () => ({}),
  } as any;

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    executionContext: mockExecutionContext,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('read_code_outline')).toBe(false);
  expect(toolNames.includes('code_context_search')).toBe(false);
  expect(definition.instructions.includes('read_code_outline')).toBe(false);
});

it('getAgentDefinition does not filter tools based on planMode setting', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });

  const definitionWithPlan = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
  });

  const toolsWithPlan = definitionWithPlan.tools.map((tool) => tool.name);
  expect(toolsWithPlan.includes('create_file')).toBe(true);
  expect(toolsWithPlan.includes('search_replace')).toBe(true);

  const settingsServiceWithoutPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': false,
  });

  const definitionWithoutPlan = getAgentDefinition({
    settingsService: settingsServiceWithoutPlan,
    loggingService: mockLogger,
  });

  const toolsWithoutPlan = definitionWithoutPlan.tools.map((tool) => tool.name);
  expect(toolsWithoutPlan.includes('create_file')).toBe(true);
  expect(toolsWithoutPlan.includes('search_replace')).toBe(true);
});

it('getAgentDefinition includes AGENTS.md and full envInfo for orchestrator mode and plan mode', () => {
  // Test Orchestrator Mode
  const settingsOrchestrator = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });
  const definitionOrchestrator = getAgentDefinition({
    settingsService: settingsOrchestrator,
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });
  expect(definitionOrchestrator.instructions.includes('AGENTS.md contents:')).toBe(true);
  expect(definitionOrchestrator.instructions.includes('Project structure:')).toBe(true);

  // Test Plan Mode
  const settingsPlan = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.planMode': true,
  });
  const definitionPlan = getAgentDefinition({
    settingsService: settingsPlan,
    loggingService: mockLogger,
  });
  expect(definitionPlan.instructions.includes('AGENTS.md contents:')).toBe(true);
  expect(definitionPlan.instructions.includes('Project structure:')).toBe(true);
});

it('getAgentsInstructions loads the global ~/.agents/AGENTS.md when present, before the project file', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = await mkdtemp(join(tmpdir(), 'term2-global-agents-'));
  const project = await mkdtemp(join(tmpdir(), 'term2-project-agents-'));
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeFile(join(home, '.agents', 'AGENTS.md'), 'Global agent guidance');
  await writeFile(join(project, 'AGENTS.md'), 'Project agent guidance');

  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const instructions = getAgentsInstructions(project);
    expect(instructions).toContain('Global AGENTS.md contents (~/.agents/AGENTS.md):');
    expect(instructions).toContain('Global agent guidance');
    expect(instructions).toContain('AGENTS.md contents:');
    expect(instructions).toContain('Project agent guidance');
    // Global guidance is appended first so project guidance stays closest to the model.
    expect(instructions.indexOf('Global agent guidance')).toBeLessThan(instructions.indexOf('Project agent guidance'));
  } finally {
    spy.mockRestore();
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

it('getAgentsInstructions loads only the project AGENTS.md when no global file exists', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = await mkdtemp(join(tmpdir(), 'term2-global-agents-none-'));
  const project = await mkdtemp(join(tmpdir(), 'term2-project-agents-none-'));
  await writeFile(join(project, 'AGENTS.md'), 'Project only guidance');

  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const instructions = getAgentsInstructions(project);
    expect(instructions).not.toContain('Global AGENTS.md contents');
    expect(instructions).toContain('AGENTS.md contents:');
    expect(instructions).toContain('Project only guidance');
  } finally {
    spy.mockRestore();
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

it('getAgentsInstructions skips an empty global AGENTS.md but still loads the project file', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const home = await mkdtemp(join(tmpdir(), 'term2-global-agents-empty-'));
  const project = await mkdtemp(join(tmpdir(), 'term2-project-agents-empty-'));
  await mkdir(join(home, '.agents'), { recursive: true });
  await writeFile(join(home, '.agents', 'AGENTS.md'), '   \n  \n');
  await writeFile(join(project, 'AGENTS.md'), 'Project guidance only');

  const spy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    const instructions = getAgentsInstructions(project);
    expect(instructions).not.toContain('Global AGENTS.md contents');
    expect(instructions).toContain('AGENTS.md contents:');
    expect(instructions).toContain('Project guidance only');
  } finally {
    spy.mockRestore();
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

it('getAgentDefinition includes worktree hygiene fragment in standard, mentor, plan, and orchestrator modes', () => {
  const standard = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
    }),
    loggingService: mockLogger,
  });
  expect(standard.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const mentor = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.mentorMode': true,
    }),
    loggingService: mockLogger,
  });
  expect(mentor.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const plan = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.planMode': true,
    }),
    loggingService: mockLogger,
  });
  expect(plan.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(true);

  const orchestrator = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.orchestratorMode': true,
    }),
    loggingService: mockLogger,
    ...orchestratorSubagentDeps,
  });
  expect(orchestrator.instructions).toContain(WORKTREE_HYGIENE_FRAGMENT_MARKER);
  expect(orchestrator.instructions).toContain('Run `git status --short` or an equivalent read-only git status command');
  expect(orchestrator.instructions).toContain('If pre-existing dirty files overlap with your current task');
  expect(orchestrator.instructions).toContain(
    'Before editing code, run the smallest relevant available test, lint, typecheck, or validation command as a baseline.',
  );
  expect(orchestrator.instructions).toContain('After your changes, rerun the same command and compare results');
});

it('getAgentDefinition omits worktree hygiene fragment in lite mode', () => {
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({
      'agent.model': 'gpt-4o',
      'app.liteMode': true,
    }),
    loggingService: mockLogger,
  });

  expect(definition.instructions.includes(WORKTREE_HYGIENE_FRAGMENT_MARKER)).toBe(false);
});

it('getAgentDefinition registers activate_skill tool and includes catalog when skills exist', () => {
  const mockSkillsService = {
    getAvailableSkillsForModel: () => [
      {
        name: 'test-skill',
        description: 'Test skill description',
        location: '/path/to/SKILL.md',
        isProjectLevel: true,
        body: 'Body',
        rawContent: 'Raw',
      },
    ],
    getSkillCatalog: () => '<available_skills>Mock Catalog</available_skills>',
  } as any;

  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    skillsService: mockSkillsService,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('activate_skill')).toBe(true);
  expect(definition.instructions.includes('<available_skills>Mock Catalog</available_skills>')).toBe(true);
});

it('getAgentDefinition omits activate_skill tool and catalog when skills do not exist', () => {
  const mockSkillsService = {
    getAvailableSkillsForModel: () => [],
    getSkillCatalog: () => '',
  } as any;

  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o' }),
    loggingService: mockLogger,
    skillsService: mockSkillsService,
  });

  const toolNames = definition.tools.map((tool) => tool.name);
  expect(toolNames.includes('activate_skill')).toBe(false);
  expect(definition.instructions.includes('<available_skills>')).toBe(false);
});

it('getEnvInfo states the local home directory in both standard and lite mode', () => {
  const spy = vi.spyOn(os, 'homedir').mockReturnValue('/Users/testuser');
  try {
    const settingsService = createMockSettingsService({ 'app.shellPath': '/bin/zsh' });

    const standard = getEnvInfo(settingsService);
    expect(standard).toContain('home (`~`): /Users/testuser');

    const lite = getEnvInfo(settingsService, undefined, true);
    expect(lite).toContain('home (`~`): /Users/testuser');
  } finally {
    spy.mockRestore();
  }
});

it('getEnvInfo omits the home directory for remote sessions, whose home this process cannot know', () => {
  const spy = vi.spyOn(os, 'homedir').mockReturnValue('/Users/testuser');
  try {
    const sshService = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
      readFile: async () => '',
      writeFile: async () => {},
      mkdir: async () => {},
    } as any;
    const remote = new ExecutionContext(sshService, '/srv/app');

    const info = getEnvInfo(createMockSettingsService({ 'app.shellPath': '/bin/zsh' }), remote);
    expect(info).not.toContain('/Users/testuser');
    expect(info).not.toContain('home (`~`)');
  } finally {
    spy.mockRestore();
  }
});

// ── Tool capability toggles (tools.<group>.enabled) ──────────────────────────
// Phase 1 contract from docs/plans/tool-toggle-setting-design.md: disabling a
// group must remove every tool whose registration consults it — including the
// ask_mentor and run_subagent/async paths that read the capability set
// directly, not through hasCapability — and drop its capability-gated prompt
// fragments, without touching any other group's surface. The table test runs
// against the standard profile with a gpt-4o model (non-apply-patch branch, so
// create_file/search_replace/grep/glob all register) and
// app.searchViaShell=off.

const toggleTestSkillsService = {
  getAvailableSkillsForModel: () => [
    {
      name: 'test-skill',
      description: 'Test skill description',
      location: '/path/to/SKILL.md',
      isProjectLevel: true,
      body: 'Body',
      rawContent: 'Raw',
    },
  ],
  getSkillCatalog: () => '<available_skills>Mock Catalog</available_skills>',
} as any;

const toggleTestDeps = {
  loggingService: mockLogger,
  askMentor: async () => 'mentor answer',
  runSubagent: async () => makeSubagentResult('subagent'),
  ...orchestratorSubagentDeps,
  getAskUserAnswer: () => 'user answer',
  sessionBrowser: new SessionBrowser(() => ({ projectPath: '/project' })),
  requestSessionRollover: () => ({ ok: true, status: 'rollover_requested', rolloverId: 'rollover-1' } as const),
  backgroundShellRegistry: new BackgroundShellRegistry<any>(),
  configureTaskCheckIn: () => ({ ok: true }),
  setTaskCheckInPolicy: () => {},
  skillsService: toggleTestSkillsService,
};

const toggleTestSettings = {
  'agent.model': 'gpt-4o',
  'app.searchViaShell': 'off',
  'agent.smartModel': 'gpt-4o-mini',
};

it('tools.<group>.enabled toggles remove exactly their own tools and prompt fragments', () => {
  const baseline = getAgentDefinition({
    settingsService: createMockSettingsService(toggleTestSettings),
    ...toggleTestDeps,
  });
  const baselineNames = baseline.tools.map((tool) => tool.name);

  const rows: Array<{ key: string; absent: string[]; markers?: string[] }> = [
    { key: 'tools.shell.enabled', absent: ['shell'] },
    { key: 'tools.web.enabled', absent: ['web_search', 'web_fetch'] },
    // read_file goes via the read branch; grep/glob additionally consult the
    // effective read capability inside their registration condition.
    { key: 'tools.fileRead.enabled', absent: ['read_file', 'grep', 'glob'] },
    // Known coupling, recorded not fixed (design doc rule: deviations observed
    // during implementation get follow-ups, not silent rewrites): for standard
    // non-gpt5 models grep/glob register INSIDE the write branch (agent.ts
    // standard else-branch), so disabling fileWrite also removes the search
    // pair. Decoupling search registration from the write branch is the filed
    // follow-up, not Phase 1 scope.
    { key: 'tools.fileWrite.enabled', absent: ['create_file', 'search_replace', 'grep', 'glob'] },
    {
      key: 'tools.memory.enabled',
      absent: baselineNames.filter((name) => name.startsWith('memory_')),
      // Sentence unique to the memory.md fragment (heading levels also appear
      // in some base prompts).
      markers: ['Use global for cross-project preferences and reusable knowledge'],
    },
    {
      key: 'tools.sessions.enabled',
      absent: ['session_list', 'session_search', 'session_read', 'session_rollover'],
      markers: ['Prior-session transcripts'],
    },
    { key: 'tools.skills.enabled', absent: ['activate_skill'], markers: ['<available_skills>'] },
    { key: 'tools.mentor.enabled', absent: ['ask_mentor'] },
    {
      key: 'tools.subagents.enabled',
      // run_subagent_async (createRunSubagentAsyncToolDefinition) is never
      // registered by the composition root — async launches ride on
      // run_subagent's execution parameter — so it is absent from both builds.
      // configure_task_check_in stays registered here because its OR-condition
      // has a background-tasks branch that is still satisfied in this fixture;
      // the backgroundTasks row below is the toggle that removes it.
      absent: ['run_subagent', 'get_subagent_result', 'get_subagent_status', 'send_message', 'cancel_run'],
      markers: ['A subagent runs in its own context and returns only a summary'],
    },
    {
      key: 'tools.backgroundTasks.enabled',
      absent: ['get_shell_job', 'cancel_shell_job', 'configure_task_check_in'],
      markers: ['### Background shell jobs'],
    },
    { key: 'tools.userInteraction.enabled', absent: ['ask_user'] },
    { key: 'tools.codeContext.enabled', absent: ['read_code_outline', 'code_context_search'] },
  ];

  for (const row of rows) {
    // Precondition: the group's tools exist while the toggle is at its default.
    for (const name of row.absent) {
      expect(baselineNames, `${row.key} baseline should contain ${name}`).toContain(name);
    }

    const toggled = getAgentDefinition({
      settingsService: createMockSettingsService({ ...toggleTestSettings, [row.key]: false }),
      ...toggleTestDeps,
    });
    const toggledNames = toggled.tools.map((tool) => tool.name);

    // Exact list equality: the group's tools are gone and nothing else moved.
    expect(toggledNames, `${row.key}=false must remove exactly [${row.absent.join(', ')}]`).toEqual(
      baselineNames.filter((name) => !row.absent.includes(name)),
    );

    if (row.markers?.length) {
      for (const marker of row.markers) {
        expect(baseline.instructions, `${row.key} baseline should contain "${marker}"`).toContain(marker);
        expect(toggled.instructions, `${row.key}=false must drop prompt marker "${marker}"`).not.toContain(marker);
      }
    } else {
      // Groups without a capability-gated prompt fragment leave the prompt untouched.
      expect(toggled.instructions, `${row.key}=false must not change the prompt`).toBe(baseline.instructions);
    }
  }
});

it('tool capability toggles default to enabled so the default tool surface is unchanged', () => {
  const withDefaults = getAgentDefinition({
    settingsService: createMockSettingsService(toggleTestSettings),
    ...toggleTestDeps,
  });
  const allExplicitlyEnabled = getAgentDefinition({
    settingsService: createMockSettingsService({
      ...toggleTestSettings,
      'tools.shell.enabled': true,
      'tools.web.enabled': true,
      'tools.fileRead.enabled': true,
      'tools.fileWrite.enabled': true,
      'tools.memory.enabled': true,
      'tools.sessions.enabled': true,
      'tools.skills.enabled': true,
      'tools.mentor.enabled': true,
      'tools.subagents.enabled': true,
      'tools.backgroundTasks.enabled': true,
      'tools.userInteraction.enabled': true,
      'tools.codeContext.enabled': true,
    }),
    ...toggleTestDeps,
  });

  expect(allExplicitlyEnabled.tools.map((tool) => tool.name)).toEqual(withDefaults.tools.map((tool) => tool.name));
  expect(allExplicitlyEnabled.instructions).toBe(withDefaults.instructions);
});

it('tools.fileRead.enabled removes the lite file tools entirely (Lite outside-workspace authority is liteMode-keyed and out of Phase 1 scope)', () => {
  const liteSettings = { 'app.liteMode': true, 'app.searchViaShell': 'off' };
  const enabled = getAgentDefinition({
    settingsService: createMockSettingsService(liteSettings),
    ...toggleTestDeps,
  });
  const enabledNames = enabled.tools.map((tool) => tool.name);
  expect(enabledNames).toContain('read_file');
  expect(enabledNames).toContain('grep');
  expect(enabledNames).toContain('glob');

  const disabled = getAgentDefinition({
    settingsService: createMockSettingsService({ ...liteSettings, 'tools.fileRead.enabled': false }),
    ...toggleTestDeps,
  });
  const disabledNames = disabled.tools.map((tool) => tool.name);
  expect(disabledNames).not.toContain('read_file');
  expect(disabledNames).not.toContain('grep');
  expect(disabledNames).not.toContain('glob');

  // Documented Phase 1 limitation (design doc, Acknowledged gaps #3): with the
  // toggle ON, Lite still reads outside the workspace because liteMode — not a
  // capability — grants that authority. Lite's allowOutsideWorkspace is set at
  // factory time from the liteMode branch (agent.ts lite branch), so no setting
  // can express workspace-only reads until outside-workspace eligibility is
  // re-derived from the effective external-read capability. The assertions
  // above pin the part Phase 1 does control: the toggle removes the lite file
  // tools entirely when off and leaves Lite's surface unchanged otherwise.
});
