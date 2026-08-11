import { describe, expect, it } from 'vitest';
import type { ISettingsService } from '../service-interfaces.js';
import { loadRoleDefinition } from './role-loader.js';

function settings(values: Record<string, unknown>): ISettingsService {
  return {
    get: (key: any) => values[key] as any,
    getDynamic: (key: string) => values[key],
    set: () => {},
    setDynamic: () => {},
    setPersistent: () => {},
    setPersistentDynamic: () => {},
  };
}

describe('loadRoleDefinition ancillary tier reasoning', () => {
  it('defines explorer as an evidence collector without diagnostic or recommendation ownership', () => {
    const definition = loadRoleDefinition(
      'explorer',
      settings({
        'agent.model': 'main-model',
        'agent.provider': 'openai',
        'agent.reasoningEffort': 'low',
        'memory.enabled': true,
      }),
    );

    expect(definition.description).toContain('evidence collection');
    expect(definition.instructions).toContain('Collect and organize evidence only');
    expect(definition.instructions).toContain(
      'Do not diagnose root causes, make recommendations, choose an approach, or answer the parent task on its behalf',
    );
  });

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
