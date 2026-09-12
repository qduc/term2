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
  it('returns the definition unchanged when no pool is configured for the role', () => {
    const selector = new SubagentRolePoolSelector(settings({}));
    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);
    expect(selector.hasPool('explorer')).toBe(false);
  });

  it('returns the definition unchanged for a role with no pool key (mentor)', () => {
    const selector = new SubagentRolePoolSelector(settings({ 'agent.mentorPool': [{ model: 'pool-model' }] }));
    expect(selector.resolveForSpawn('mentor', baseDefinition)).toBe(baseDefinition);
  });

  it('advances round-robin across spawns and wraps modulo the pool length', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.subagentExplorerPool': [{ model: 'model-a' }, { model: 'model-b', provider: 'openrouter' }],
      }),
    );

    expect(selector.hasPool('explorer')).toBe(true);
    const first = selector.resolveForSpawn('explorer', baseDefinition);
    const second = selector.resolveForSpawn('explorer', baseDefinition);
    const third = selector.resolveForSpawn('explorer', baseDefinition);

    expect(first).toMatchObject({ model: 'model-a', provider: 'base-provider' });
    expect(second).toMatchObject({ model: 'model-b', provider: 'openrouter' });
    expect(third).toMatchObject({ model: 'model-a', provider: 'base-provider' });
  });

  it('keeps separate cursors per role', () => {
    const selector = new SubagentRolePoolSelector(
      settings({
        'agent.subagentExplorerPool': [{ model: 'explorer-a' }, { model: 'explorer-b' }],
        'agent.subagentWorkerPool': [{ model: 'worker-a' }],
      }),
    );

    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('explorer-a');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('explorer-b');
    expect(selector.resolveForSpawn('worker', baseDefinition).model).toBe('worker-a');
  });

  it('reads the pool live from settings, so edits apply without restart', () => {
    const svc = settings({ 'agent.subagentExplorerPool': [] });
    const selector = new SubagentRolePoolSelector(svc);

    expect(selector.resolveForSpawn('explorer', baseDefinition)).toBe(baseDefinition);

    svc.setValues({ 'agent.subagentExplorerPool': [{ model: 'new-model' }] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('new-model');
  });

  it('shrinking the pool wraps the cursor modulo the new length instead of throwing', () => {
    const svc = settings({
      'agent.subagentExplorerPool': [{ model: 'a' }, { model: 'b' }, { model: 'c' }],
    });
    const selector = new SubagentRolePoolSelector(svc);
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 1 (picked 'a')
    selector.resolveForSpawn('explorer', baseDefinition); // cursor -> 2 (picked 'b')

    svc.setValues({ 'agent.subagentExplorerPool': [{ model: 'x' }] });
    expect(selector.resolveForSpawn('explorer', baseDefinition).model).toBe('x');
  });

  it('falls back to the base provider/reasoningEffort when an entry omits them', () => {
    const selector = new SubagentRolePoolSelector(
      settings({ 'agent.subagentLibrarianPool': [{ model: 'librarian-model' }] }),
    );
    const resolved = selector.resolveForSpawn('librarian', {
      ...baseDefinition,
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
