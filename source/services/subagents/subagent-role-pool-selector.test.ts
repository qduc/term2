import { describe, expect, it } from 'vitest';
import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentDefinition } from './types.js';
import { SubagentRolePoolSelector } from './subagent-role-pool-selector.js';

function settings(
  values: Record<string, unknown>,
): ISettingsService & { setValues: (v: Record<string, unknown>) => void } {
  let store = values;
  return {
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: () => {},
    setDynamic: () => {},
    setPersistent: () => {},
    setPersistentDynamic: () => {},
    setValues: (v: Record<string, unknown>) => {
      store = v;
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
  it('returns the definition unchanged when no tier pool is configured for the role', () => {
    const selector = new SubagentRolePoolSelector(settings({}));
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);
    expect(selector.hasPool('explorer')).toBe(false);
  });

  it('returns the definition unchanged for a role with no tier pool (mentor)', () => {
    const selector = new SubagentRolePoolSelector(settings({ 'agent.mentorPool': [{ model: 'pool-model' }] }));
    expect(selector.resolveForSpawn('mentor', baseDefinition)).toBe(baseDefinition);
  });

  it('advances round-robin across spawns and wraps modulo the tier pool length', () => {
    const selector = new SubagentRolePoolSelector(settings({ 'agent.cheapModel': ['model-a', 'model-b'] }));

    expect(selector.hasPool('explorer')).toBe(true);
    const first = selector.resolveForSpawn('explorer', baseDefinition);
    const second = selector.resolveForSpawn('explorer', baseDefinition);
    const third = selector.resolveForSpawn('explorer', baseDefinition);

    expect(first).toMatchObject({ model: 'model-a', provider: 'base-provider' });
    expect(second).toMatchObject({ model: 'model-b', provider: 'base-provider' });
    expect(third).toMatchObject({ model: 'model-a', provider: 'base-provider' });
  });

  it('keeps separate cursors per role and maps roles to their tiers', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        // Explorer and librarian share the cheap tier pool; each role keeps
        // its own cursor into it.
        'agent.cheapModel': ['cheap-a', 'cheap-b'],
        'agent.balancedModel': ['worker-a'],
      }),
    );

    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('cheap-a');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
    expect(selector.resolveForSpawn('librarian', { ...baseDefinition, role: 'librarian' }).model).toBe('cheap-a');
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('cheap-b');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
  });

  it('treats a legacy bare-string tier setting as a single-entry pool', () => {
    const selector = new SubagentRolePoolSelector(settings({ 'agent.cheapModel': 'only-model' }));
    expect(selector.hasPool('explorer')).toBe(true);
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('only-model');
  });

  it('reads the pool live from settings, so edits apply without restart', () => {
    const svc = settings({ 'agent.cheapModel': [] });
    const selector = new SubagentRolePoolSelector(svc);

    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);

    svc.setValues({ 'agent.cheapModel': ['new-model'] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('new-model');
  });

  it('shrinking the pool wraps the cursor modulo the new length instead of throwing', () => {
    const svc = settings({ 'agent.cheapModel': ['a', 'b', 'c'] });
    const selector = new SubagentRolePoolSelector(svc);
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 1 (picked 'a')
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 2 (picked 'b')

    svc.setValues({ 'agent.cheapModel': ['x'] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('x');
  });

  it('leaves provider and reasoningEffort to the tier-resolved base definition', () => {
    const selector = new SubagentRolePoolSelector(settings({ 'agent.cheapModel': ['librarian-model'] }));
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
});
