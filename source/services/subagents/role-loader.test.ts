import { describe, expect, it } from 'vitest';
import type { ISettingsService } from '../service-interfaces.js';
import { loadRoleDefinition } from './role-loader.js';

function settings(values: Record<string, unknown>): ISettingsService {
  return {
    get: <T>(key: string) => values[key] as T,
    set: () => {},
  };
}

describe('loadRoleDefinition ancillary tier reasoning', () => {
  it('uses global reasoning effort when the mentor legacy setting only has its schema default', () => {
    const definition = loadRoleDefinition(
      'mentor',
      settings({
        'agent.model': 'main-model',
        'agent.provider': 'openai',
        'agent.reasoningEffort': 'high',
        'agent.mentorReasoningEffort': 'default',
        'memory.enabled': true,
      }),
    );

    expect(definition.reasoningEffort).toBe('high');
  });

  it.each([
    ['mentor', 'smart', 'high'],
    ['worker', 'balanced', 'medium'],
    ['researcher', 'balanced', 'medium'],
    ['explorer', 'cheap', 'low'],
    ['librarian', 'cheap', 'low'],
  ] as const)('%s uses agent.%sReasoningEffort', (role, tier, effort) => {
    const definition = loadRoleDefinition(
      role,
      settings({
        'agent.model': 'main-model',
        'agent.provider': 'openai',
        'agent.reasoningEffort': 'minimal',
        [`agent.${tier}ReasoningEffort`]: effort,
        'memory.enabled': true,
      }),
    );

    expect(definition.reasoningEffort).toBe(effort);
  });
});
