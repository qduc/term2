import { describe, expect, it } from 'vitest';
import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentDefinition } from './types.js';
import { SubagentRolePoolSelector } from './subagent-role-pool-selector.js';
import { AgentSettingsSchema } from '../settings/settings-schema.js';

function settings(
  values: Record<string, unknown>,
): ISettingsService & { setValues: (v: Record<string, unknown>) => void } {
  const bind = (values: Record<string, unknown>): Record<string, unknown> => {
    const store: Record<string, unknown> = {
      'agent.modelSelection': { model: 'base-model', provider: 'base-provider' },
      ...values,
    };
    const agent = AgentSettingsSchema.parse(
      Object.fromEntries(Object.entries(store).map(([key, value]) => [key.slice(6), value])),
    );
    for (const tier of ['smart', 'balanced', 'cheap', 'chore'] as const)
      store[`agent.${tier}Model`] = agent[`${tier}Model`];
    return store;
  };
  let store = bind(values);
  return {
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: () => {},
    setDynamic: () => {},
    setPersistent: () => {},
    setPersistentDynamic: () => {},
    setValues: (v: Record<string, unknown>) => {
      store = bind(v);
    },
  };
}

const baseDefinition: SubagentDefinition = {
  role: 'explorer',
  name: 'explorer',
  instructions: 'do stuff',
  canRead: true,
  canWrite: false,
  canSearchWeb: false,
  canRunShell: false,
  maxTurns: 200,
  model: 'base-model',
  provider: 'base-provider',
  reasoningEffort: 'default',
  description: '',
};

describe('SubagentRolePoolSelector', () => {
  it('uses the live bound pool selection instead of a stale definition', () => {
    const svc = settings({ 'agent.cheapModel': [{ model: 'model-a', provider: 'codex' }] });
    const selector = new SubagentRolePoolSelector(svc);
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toMatchObject({ provider: 'codex' });
    svc.setValues({ 'agent.cheapModel': [{ model: 'model-a', provider: 'zai' }] });
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toMatchObject({ provider: 'zai' });
  });

  it('keeps explicit provider bindings across fallback changes and health failures', () => {
    const svc = settings({
      'agent.balancedModel': [
        { model: 'same-name', provider: 'codex' },
        { model: 'same-name', provider: 'zai' },
      ],
    });
    const selector = new SubagentRolePoolSelector(svc);
    const first = selector.resolveForSpawn('worker', baseDefinition);
    expect(first).toMatchObject({ provider: 'codex', model: 'same-name' });
    selector.markUnhealthy(first, 'balance');
    expect(selector.resolveForSpawn('worker', baseDefinition)).toMatchObject({ provider: 'zai', model: 'same-name' });
  });
  it('returns the definition unchanged when no tier pool is configured for the role', () => {
    const selector = new SubagentRolePoolSelector(settings({}));
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);
    expect(selector.hasPool('explorer')).toBe(false);
  });

  it('returns the definition unchanged for a role with no tier pool (mentor)', () => {
    const selector = new SubagentRolePoolSelector(
      settings({ 'agent.mentorPool': [{ model: 'pool-model', provider: 'base-provider' }] }),
    );
    expect(selector.resolveForSpawn('mentor', baseDefinition)).toBe(baseDefinition);
  });

  it('advances round-robin across spawns and wraps modulo the tier pool length', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.cheapModel': [
          { model: 'model-a', provider: 'base-provider' },
          { model: 'model-b', provider: 'base-provider' },
        ],
      }),
    );

    expect(selector.hasPool('explorer')).toBe(true);
    const first = selector.resolveForSpawn('explorer', baseDefinition);
    const second = selector.resolveForSpawn('explorer', baseDefinition);
    const third = selector.resolveForSpawn('explorer', baseDefinition);

    expect(first).toMatchObject({ model: 'model-a', provider: 'base-provider' });
    expect(second).toMatchObject({ model: 'model-b', provider: 'base-provider' });
    expect(third).toMatchObject({ model: 'model-a', provider: 'base-provider' });
  });

  it('skips an unhealthy provider/model across roles and admits it after cooldown', () => {
    let now = 1000;
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.cheapModel': [
          { model: 'a', provider: 'base-provider' },
          { model: 'b', provider: 'base-provider' },
        ],
      }),
      () => now,
    );
    const first = selector.resolveForSpawn('explorer', baseDefinition);
    selector.markUnhealthy(first, 'balance');
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('b');
    expect(selector.resolveForSpawn('librarian', baseDefinition).model).toBe('b');
    now += 10 * 60 * 1000;
    expect(selector.resolveForSpawn('librarian', baseDefinition).model).toBe('a');
  });

  it('reports every failed entry when the pool has no healthy option', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.cheapModel': [
          { model: 'a', provider: 'base-provider' },
          { model: 'b', provider: 'base-provider' },
        ],
      }),
    );
    selector.markUnhealthy(selector.resolveForSpawn('explorer', baseDefinition), 'balance');
    selector.markUnhealthy(selector.resolveForSpawn('explorer', baseDefinition), 'authentication');
    expect(() => selector.resolveForSpawn('explorer', baseDefinition)).toThrow(/a.*balance.*b.*authentication/);
  });

  it('keeps separate cursors per role and maps roles to their tiers', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        // Explorer and librarian share the cheap tier pool; each role keeps
        // its own cursor into it.
        'agent.cheapModel': [
          { model: 'cheap-a', provider: 'base-provider' },
          { model: 'cheap-b', provider: 'base-provider' },
        ],
        'agent.balancedModel': [{ model: 'worker-a', provider: 'base-provider' }],
      }),
    );

    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('cheap-a');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
    expect(selector.resolveForSpawn('librarian', { ...baseDefinition, role: 'librarian' }).model).toBe('cheap-a');
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('cheap-b');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
  });

  it('rejects a legacy bare-string tier setting', () => {
    expect(() => settings({ 'agent.cheapModel': 'only-model' })).toThrow();
  });

  it('reads the pool live from settings, so edits apply without restart', () => {
    const svc = settings({ 'agent.cheapModel': [] });
    const selector = new SubagentRolePoolSelector(svc);

    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);

    svc.setValues({ 'agent.cheapModel': [{ model: 'new-model', provider: 'base-provider' }] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('new-model');
  });

  it('shrinking the pool wraps the cursor modulo the new length instead of throwing', () => {
    const svc = settings({
      'agent.cheapModel': [
        { model: 'a', provider: 'base-provider' },
        { model: 'b', provider: 'base-provider' },
        { model: 'c', provider: 'base-provider' },
      ],
    });
    const selector = new SubagentRolePoolSelector(svc);
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 1 (picked 'a')
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 2 (picked 'b')

    svc.setValues({ 'agent.cheapModel': [{ model: 'x', provider: 'base-provider' }] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('x');
  });

  it('resolves provider live while preserving the definition reasoning effort', () => {
    const selector = new SubagentRolePoolSelector(
      settings({ 'agent.cheapModel': [{ model: 'librarian-model', provider: 'inherited-provider' }] }),
    );
    const resolved = selector.resolveForSpawn('librarian', {
      ...baseDefinition,
      role: 'librarian',
      provider: 'inherited-provider',
      reasoningEffort: 'high',
    });
    expect(resolved).toMatchObject({
      model: 'librarian-model',
      provider: 'inherited-provider',
      reasoningEffort: 'high',
    });
  });

  it('runs each bound pool entry on its own provider', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.cheapModel': [
          { model: 'model-a', provider: 'base-provider' },
          { model: 'model-b', provider: 'codex' },
        ],
      }),
    );

    expect(selector.resolveForSpawn('explorer', baseDefinition)).toMatchObject({
      model: 'model-a',
      provider: 'base-provider',
    });
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toMatchObject({ model: 'model-b', provider: 'codex' });
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toMatchObject({
      model: 'model-a',
      provider: 'base-provider',
    });
  });

  it('does not carry the first entry provider onto other bound entries', () => {
    // loadRoleDefinition pairs the definition with the first entry, so its
    // provider is that entry's pin, not the tier's.
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.cheapModel': [
          { model: 'model-a', provider: 'codex' },
          { model: 'model-b', provider: 'DeepSeek' },
        ],
      }),
    );
    const pinnedDefinition = { ...baseDefinition, model: 'model-a', provider: 'codex' };

    selector.resolveForSpawn('explorer', pinnedDefinition);
    expect(selector.resolveForSpawn('explorer', pinnedDefinition)).toMatchObject({
      model: 'model-b',
      provider: 'DeepSeek',
    });
  });
});
