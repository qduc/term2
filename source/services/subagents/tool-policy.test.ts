import { describe, expect, it } from 'vitest';
import { SubagentToolFactory, SubagentToolPolicy } from './tool-policy.js';
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

function buildToolNames(definition: SubagentDefinition): string[] {
  const settings = createMockSettings();
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
