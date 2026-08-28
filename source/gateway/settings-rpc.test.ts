import { describe, expect, it, vi } from 'vitest';
import { applySettingsChanges, buildSettingsProjection, deleteCredential, setCredential } from './settings-rpc.js';

function authority(values: Record<string, unknown>) {
  return {
    getDynamic: (key: string) => values[key],
    getSource: (key: string) => (key in values ? 'config' : 'default'),
    setPersistentDynamic: (key: string, value: unknown) => {
      values[key] = value;
      return { status: 'saved' as const };
    },
    setPersistentDynamicTransaction: (changes: readonly { key: string; value: unknown }[]) => {
      for (const change of changes) values[change.key] = change.value;
      return { status: 'saved' as const };
    },
    reset: (key?: string) => {
      if (key) delete values[key];
      return { status: 'saved' as const };
    },
    get: (key: string) => values[key],
    set: () => {},
    setDynamic: () => {},
  } as any;
}

describe('settings RPC policy boundary', () => {
  it('projects explicit safe keys and strips credential values and metadata', () => {
    const settings = authority({
      'agent.provider': 'openai',
      'agent.model': 'gpt-5',
      'agent.reasoningEffort': 'high',
      'agent.openai.apiKey': 'secret-value',
      'shell.autoApproveMode': 'off',
      'sandbox.enabled': true,
    });
    const projection = buildSettingsProjection(settings);
    expect(projection.settings.safeDefaults['agent.model']).toMatchObject({ value: 'gpt-5', source: 'config' });
    expect(projection.settings.safeDefaults['agent.model']?.scope).toBe('session');
    expect(projection.settings.safeDefaults['logging.logLevel']?.scope).toBe('global');
    expect(projection.settings.credentials.openai).toMatchObject({
      configured: true,
      source: 'setting',
      writable: true,
    });
    expect(JSON.stringify(projection)).not.toContain('secret-value');
    expect(JSON.stringify(projection)).not.toMatch(/credentialPath|environmentKey|apiKey/);
  });

  it('rejects stale revisions and supports write-only credential set/delete', () => {
    const settings = authority({ 'agent.model': 'old', 'agent.openai.apiKey': undefined });
    const current = buildSettingsProjection(settings);
    expect(() => applySettingsChanges(settings, 'stale', [{ key: 'agent.model', value: 'new' }])).toThrowError(
      expect.objectContaining({ code: 'settings_conflict' }),
    );
    expect(() => applySettingsChanges(settings, current.revision, [{ key: 'agent.model', value: 'new' }])).toThrowError(
      expect.objectContaining({ code: 'settings_not_allowed' }),
    );
    const next = applySettingsChanges(settings, current.revision, [{ key: 'logging.logLevel', value: 'debug' }]);
    expect(next.settings.safeDefaults['logging.logLevel']?.value).toBe('debug');
    expect(setCredential(settings, 'openai', 'secret-value')).toEqual({
      status: 'saved',
      configured: true,
      source: 'setting',
    });
    expect(JSON.stringify(setCredential(settings, 'openai', 'another-secret'))).not.toContain('another-secret');
    expect(deleteCredential(settings, 'openai')).toEqual({ status: 'deleted', configured: false });
  });

  it('treats inherited environment credentials as non-writable', () => {
    const settings = authority({ 'agent.openai.apiKey': 'environment-secret' });
    settings.getSource = (key: string) => (key === 'agent.openai.apiKey' ? 'environment' : 'default');
    expect(() => setCredential(settings, 'openai', 'new-secret')).toThrowError(
      expect.objectContaining({ code: 'settings_not_allowed' }),
    );
    expect(deleteCredential(settings, 'openai')).toEqual({
      status: 'unchanged',
      configured: true,
      source: 'environment',
    });
  });

  it('normalizes the SettingsService env source and requires a saved batch result', () => {
    const settings = authority({
      'webSearch.tavily.apiKey': 'environment-secret',
      'webSearch.exa.apiKey': 'environment-secret',
    });
    settings.getSource = (key: string) =>
      key === 'webSearch.tavily.apiKey' || key === 'webSearch.exa.apiKey' ? 'env' : 'default';
    for (const credentialId of ['tavily', 'exa'] as const) {
      expect(buildSettingsProjection(settings).settings.credentials[credentialId]).toMatchObject({
        source: 'environment',
        writable: false,
      });
      expect(() => setCredential(settings, credentialId, 'new-secret')).toThrowError(
        expect.objectContaining({ code: 'settings_not_allowed' }),
      );
      expect(deleteCredential(settings, credentialId)).toEqual({
        status: 'unchanged',
        configured: true,
        source: 'environment',
      });
    }
    expect(() =>
      applySettingsChanges(settings, buildSettingsProjection(settings).revision, [
        { key: 'logging.logLevel', value: 'debug' },
      ]),
    ).not.toThrow();
    settings.setPersistentDynamicTransaction = () => undefined;
    expect(() =>
      applySettingsChanges(settings, buildSettingsProjection(settings).revision, [
        { key: 'logging.logLevel', value: 'info' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'not_persisted' }));
  });

  it('delegates the complete batch to one atomic settlement', () => {
    const settings = authority({ 'logging.logLevel': 'info' });
    const transaction = vi.fn(() => ({ status: 'not-persisted' as const }));
    settings.setPersistentDynamicTransaction = transaction;
    const before = buildSettingsProjection(settings);
    expect(() =>
      applySettingsChanges(settings, before.revision, [
        { key: 'logging.logLevel', value: 'debug' },
        { key: 'logging.logLevel', value: 'trace' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'not_persisted' }));
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith([
      { key: 'logging.logLevel', value: 'debug' },
      { key: 'logging.logLevel', value: 'trace' },
    ]);
    expect(buildSettingsProjection(settings).revision).toBe(before.revision);
  });
});
