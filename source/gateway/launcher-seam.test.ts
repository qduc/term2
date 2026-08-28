import { describe, expect, it } from 'vitest';
import { createSessionSettingsSnapshot } from './launcher-seam.js';

const settings = (values: Record<string, unknown>) =>
  ({
    get: <T>(key: string) => values[key] as T,
    getDynamic: (key: string) => values[key],
  } as any);

describe('local launcher seams', () => {
  it('captures a frozen, secret-free per-session settings snapshot', () => {
    const snapshot = createSessionSettingsSnapshot({
      settings: settings({
        'agent.provider': 'openai',
        'agent.model': 'gpt-5',
        'agent.reasoningEffort': 'high',
        'app.planMode': true,
        'app.liteMode': false,
        'app.mentorMode': false,
        'app.orchestratorMode': false,
        'agent.openai.apiKey': 'must-not-copy',
      }),
      effectiveToolPolicy: { allowWrite: false, autoApprove: false },
      defaultsRevision: 7,
    });

    expect(snapshot).toEqual({
      providerId: 'openai',
      modelId: 'gpt-5',
      reasoningEffort: 'high',
      mode: 'plan',
      effectiveToolPolicy: {
        allowWrite: false,
        autoApprove: false,
        allowUnsandboxed: false,
        sshEnabled: false,
      },
      defaultsRevision: 7,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('must-not-copy');
  });

  it('does not share the mutable policy object with the authority caller', () => {
    const policy = { allowWrite: true };
    const snapshot = createSessionSettingsSnapshot({
      settings: settings({ 'agent.provider': 'fixture', 'agent.model': 'fixture-model' }),
      effectiveToolPolicy: policy,
    });
    policy.allowWrite = false;
    expect(snapshot.effectiveToolPolicy.allowWrite).toBe(true);
    expect(snapshot.mode).toBe('standard');
  });
});
