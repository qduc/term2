import { it, expect, vi } from 'vitest';
import { getAgentDefinition } from './agent.js';
import { createMockSettingsService } from './services/settings/settings-service.mock.js';

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

it('adds memory tools and summary-only context when memory is enabled, and neither when disabled', async () => {
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'term2-agent-memory-'));
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
    'memory_create',
    'memory_update',
    'memory_delete',
  ]);
  expect(enabled.instructions).toContain('Durable rules.');
  expect(enabled.instructions).not.toContain('full memory content');
  expect(disabled.tools.map((tool) => tool.name).filter((name) => name.startsWith('memory_'))).toEqual([]);
  expect(disabled.instructions).not.toContain('## Persistent memory');
  expect(disabled.instructions).not.toContain('Durable rules.');
});

it('advertises librarian delegation when memory and subagent delegation are enabled', () => {
  const enabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true }),
    loggingService: mockLogger,
    runSubagent: async () => ({ finalText: 'done' }),
  });
  const disabled = getAgentDefinition({
    settingsService: createMockSettingsService({ 'app.orchestratorMode': true, 'memory.enabled': false }),
    loggingService: mockLogger,
    runSubagent: async () => ({ finalText: 'done' }),
  });

  expect(enabled.instructions).toContain('`librarian`');
  expect(disabled.instructions).not.toContain('`librarian`');
});

it('starts without injected memory context and warns when the memory index is corrupted', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'term2-agent-memory-corrupt-'));
  await writeFile(join(root, 'index.json'), '{ malformed');

  const warn = vi.fn();
  const definition = getAgentDefinition({
    settingsService: createMockSettingsService({ 'memory.directory': root }),
    loggingService: { ...mockLogger, warn },
  });

  expect(definition.tools.map((tool) => tool.name)).toContain('memory_search');
  expect(definition.instructions).not.toContain('The following memories are summaries');
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/memory context.*corrupted/i));
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
    runSubagent: async () => ({ finalText: 'subagent' }),
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
  const result = JSON.parse(
    await workflow.execute({
      code: "const agentHandle = agent({ instructions: 'x' }); await agentHandle.run({ task: 'one' }); return agentHandle.run({ task: 'two' });",
    }),
  );
  expect(result).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
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
    runSubagent: async () => 'test',
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

it('getAgentDefinition injects delegation guidance in orchestrator mode when runSubagent is provided', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'app.orchestratorMode': true,
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(true);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(true);
});

it('getAgentDefinition omits delegation guidance in standard mode even if runSubagent is provided', () => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(true);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
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
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name).includes('run_subagent')).toBe(false);
  expect(definition.instructions.includes('### Delegating to subagents')).toBe(false);
});

it('getAgentDefinition in orchestrator mode retains full memory authority', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual([
    'run_subagent',
    'shell',
    'read_file',
    'grep',
    'read_code_outline',
    'code_context_search',
    'apply_patch',
    'memory_list',
    'memory_get',
    'memory_search',
    'memory_retrieve',
    'memory_create',
    'memory_update',
    'memory_delete',
  ]);
  expect(definition.instructions).toContain('Validate any memory proposals from subagents');
  expect(definition.tools.map((tool) => tool.name).filter((name) => name.startsWith('memory_'))).toEqual([
    'memory_list',
    'memory_get',
    'memory_search',
    'memory_retrieve',
    'memory_create',
    'memory_update',
    'memory_delete',
  ]);
});

it('getAgentDefinition in orchestrator mode enables direct work while retaining delegation', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-5',
  });

  const definition = getAgentDefinition({
    settingsService,
    loggingService: mockLogger,
    runSubagent: async () => ({} as any),
  });

  expect(definition.instructions.includes('Orchestrator mode')).toBe(true);
  expect(definition.instructions).toContain('You own the user-requested outcome end to end');
  expect(definition.instructions).toContain('Directly inspect, edit, run commands, and test small or clear work');
  expect(definition.instructions).not.toContain('Delegate workspace inspection');
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
    runSubagent: async () => ({} as any),
  });

  expect(definition.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      'run_subagent',
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

it('getAgentDefinition throws if orchestratorMode is true and runSubagent is missing', () => {
  const settingsService = createMockSettingsService({
    'app.orchestratorMode': true,
    'agent.model': 'gpt-4o',
  });

  expect(() =>
    getAgentDefinition({
      settingsService,
      loggingService: mockLogger,
    }),
  ).toThrow(/orchestratorMode.*runSubagent|runSubagent.*orchestratorMode/i);
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
  expect(toolNames.includes('apply_patch')).toBe(true);
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
    runSubagent: async () => ({} as any),
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
    runSubagent: async () => ({} as any),
  });
  expect(orchestrator.instructions).toContain(WORKTREE_HYGIENE_FRAGMENT_MARKER);
  expect(orchestrator.instructions).toContain('Run `git status --short` or an equivalent read-only git status command');
  expect(orchestrator.instructions).toContain('If pre-existing dirty files overlap with your current task');
  expect(orchestrator.instructions).toContain(
    'Before editing code, run the smallest relevant available test, lint, typecheck, or validation command as a baseline.',
  );
  expect(orchestrator.instructions).toContain('After your changes, rerun the same command and compare results');
  expect(orchestrator.instructions).toContain(
    'Choose investigation, planning, delegation, implementation, review, and validation adaptively.',
  );
  expect(orchestrator.instructions).toContain('Delegation transfers execution, never outcome ownership.');
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
