import { describe, expect, it } from 'vitest';
import { SubagentToolFactory, SubagentToolPolicy } from './tool-policy.js';
import { buildInstructions } from './role-loader.js';
import type { SubagentDefinition } from './types.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
} from './test-helpers/subagent-manager-fixtures.js';

function createDefinition(overrides: Partial<SubagentDefinition>): SubagentDefinition {
  return {
    role: 'workflow-agent',
    name: 'workflow-agent',
    instructions: '',
    canRead: false,
    canWrite: true,
    canSearchWeb: false,
    canRunShell: false,
    maxTurns: 1,
    model: 'gpt-5',
    provider: 'test',
    reasoningEffort: 'default',
    ...overrides,
  };
}

function createMemorySettings(enabled = true) {
  return createMockSettings({
    memory: {
      enabled,
      directory: '/tmp/subagent-memory',
      contextBudgetChars: 1000,
      searchDefaultLimit: 10,
      searchMaxLimit: 20,
    },
  });
}

function buildToolNames(definition: SubagentDefinition, memoryEnabled = true): string[] {
  const settings = createMemorySettings(memoryEnabled);
  const policy = new SubagentToolPolicy({
    settings,
    logger: createMockLogger(),
    sessionContextService: createSessionContextService(),
  });
  return new SubagentToolFactory({ settings, logger: createMockLogger(), toolPolicy: policy })
    .buildToolDefinitions(definition, [], '', false)
    .map((tool) => tool.name);
}

describe('SubagentToolFactory editor capability selection', () => {
  it('maps an explicitly requested editor to the model-compatible editor interface', () => {
    for (const requestedEditor of ['apply_patch', 'search_replace', 'create_file']) {
      expect(buildToolNames(createDefinition({ tools: [requestedEditor] }))).toEqual(['apply_patch']);
      expect(buildToolNames(createDefinition({ model: 'other-model', tools: [requestedEditor] }))).toEqual([
        'search_replace',
        'create_file',
      ]);
    }
  });

  it('does not grant editor tools from an explicit request, shell, or read authority', () => {
    expect(
      buildToolNames(
        createDefinition({
          canRead: true,
          canWrite: false,
          canRunShell: true,
          tools: ['read_file', 'shell', 'create_file'],
        }),
      ),
    ).toEqual(['read_file', 'shell']);
  });
});

describe('SubagentToolFactory memory authority', () => {
  it.each(['explorer', 'worker', 'researcher'] as const)('gives %s read-only memory tools', (role) => {
    const tools = buildToolNames(createDefinition({ role }));

    expect(tools.filter((name) => name.startsWith('memory_'))).toEqual(['memory_list', 'memory_get', 'memory_search']);
  });

  it('keeps mentor tool-free even when memory is enabled', () => {
    expect(
      buildToolNames(
        createDefinition({
          role: 'mentor',
          canRead: false,
          canWrite: false,
        }),
      ),
    ).toEqual([]);
  });

  it('omits memory tools for disabled subagent memory', () => {
    expect(
      buildToolNames(createDefinition({ role: 'worker' }), false).filter((name) => name.startsWith('memory_')),
    ).toEqual([]);
  });

  it('gives librarian all memory tools (write access)', () => {
    const tools = buildToolNames(createDefinition({ role: 'librarian' }));

    expect(tools.filter((name) => name.startsWith('memory_'))).toEqual([
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_create',
      'memory_update',
      'memory_delete',
    ]);
  });

  it('gives librarian memory-specific guidance without automatic context injection', () => {
    const definition = createDefinition({ role: 'librarian', canRead: false, canWrite: false });
    const settings = createMemorySettings();
    const instructions = buildInstructions(definition, [], false, settings);

    expect(instructions).toContain('memory librarian');
    expect(instructions).toContain('reviewable proposal');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });

  it('keeps read-only memory guidance and proposal protocol without automatic context injection', () => {
    const definition = createDefinition({ role: 'explorer', canRead: true, canWrite: false });
    const settings = createMemorySettings();
    const instructions = buildInstructions(definition, [], false, settings);

    expect(instructions).toContain('materially improve correctness');
    expect(instructions).toContain('propose it in your final report');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });

  it.each([
    ['mentor', createDefinition({ role: 'mentor', canRead: false, canWrite: false }), true],
    ['disabled worker', createDefinition({ role: 'worker', canRead: true, canWrite: false }), false],
  ])('omits memory tools, guidance, and context for %s', (_name, definition, memoryEnabled) => {
    const settings = createMemorySettings(memoryEnabled);
    const instructions = buildInstructions(definition, [], false, settings);

    expect(buildToolNames(definition, memoryEnabled).filter((name) => name.startsWith('memory_'))).toEqual([]);
    expect(instructions).not.toContain('Persistent memory');
    expect(instructions).not.toContain('The following memories are summaries from previous sessions');
  });
});
