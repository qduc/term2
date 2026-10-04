import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { ISettingsService } from '../service-interfaces.js';
import { loadRoleDefinition, ROLE_MAX_TURNS_DEFAULT } from './role-loader.js';

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

describe('loadRoleDefinition turn budgets', () => {
  it('gives tool-using roles a generous tripwire budget and keeps mentor single-turn', () => {
    const base = {
      'agent.modelSelection': { model: 'main-model', provider: 'openai' },
      'memory.enabled': true,
    };
    expect(ROLE_MAX_TURNS_DEFAULT).toBe(200);
    expect(loadRoleDefinition('explorer', settings(base)).maxTurns).toBe(200);
    expect(loadRoleDefinition('worker', settings(base)).maxTurns).toBe(200);
    expect(loadRoleDefinition('librarian', settings(base)).maxTurns).toBe(200);
    expect(loadRoleDefinition('mentor', settings(base)).maxTurns).toBe(1);
  });
});

describe('loadRoleDefinition reviewer', () => {
  it('grants no direct workspace, shell, write, or web authority', () => {
    const definition = loadRoleDefinition(
      'reviewer',
      settings({ 'agent.modelSelection': { model: 'main-model', provider: 'openai' }, 'memory.enabled': true }),
    );

    expect(definition).toMatchObject({ canRead: false, canWrite: false, canRunShell: false, canSearchWeb: false });
    expect(definition.instructions).toContain('run_explorer');
  });
});

describe('loadRoleDefinition ancillary tier reasoning', () => {
  it('defines explorer as an evidence collector without diagnostic or recommendation ownership', () => {
    const definition = loadRoleDefinition(
      'explorer',
      settings({
        'agent.modelSelection': { model: 'main-model', provider: 'openai' },
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
        'agent.modelSelection': { model: 'main-model', provider: 'openai' },
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
    ['reviewer', 'smart', 'high'],
  ] as const)('%s uses agent.%sReasoningEffort', (role, tier, effort) => {
    const definition = loadRoleDefinition(
      role,
      settings({
        'agent.modelSelection': { model: 'main-model', provider: 'openai' },
        'agent.reasoningEffort': 'minimal',
        [`agent.${tier}ReasoningEffort`]: effort,
        'memory.enabled': true,
      }),
    );

    expect(definition.reasoningEffort).toBe(effort);
  });
});

it.each(['model: explicit-model', 'provider: explicit-host'])('rejects incomplete role frontmatter %s', (override) => {
  const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(`---\n${override}\n---\nRole instructions`);
  try {
    expect(() =>
      loadRoleDefinition(
        'worker',
        settings({
          'agent.modelSelection': { model: 'main-model', provider: 'openai' },
        }),
      ),
    ).toThrow(/model and provider together/);
  } finally {
    read.mockRestore();
  }
});

it('uses a complete frontmatter override without borrowing either field from the main selection', () => {
  const read = vi
    .spyOn(fs, 'readFileSync')
    .mockReturnValue('---\nmodel: explicit-model\nprovider: explicit-host\n---\nRole instructions');
  try {
    expect(
      loadRoleDefinition(
        'worker',
        settings({
          'agent.modelSelection': { model: 'main-model', provider: 'openai' },
        }),
      ),
    ).toMatchObject({ model: 'explicit-model', provider: 'explicit-host' });
  } finally {
    read.mockRestore();
  }
});
