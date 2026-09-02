import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderManagementSession } from './provider-management-session.js';
import { deleteCustomProvider, loadProviderItems, saveProvider } from '../../providers/provider-service.js';

// The session seam is a pure forwarder: it must hand every public operation to
// the provider-service policy functions with the live settings authority.
// Underlying policy behavior is covered by provider-service.test.ts; this file
// pins the delegation the public seam promises.
vi.mock('../../providers/provider-service.js', () => ({
  deleteCustomProvider: vi.fn(),
  loadProviderItems: vi.fn(),
  saveProvider: vi.fn(),
}));

const settings = {
  get: vi.fn(() => 'openai'),
  getDynamic: vi.fn(() => []),
  setPersistent: vi.fn(),
  setPersistentDynamic: vi.fn(),
} as any;

describe('ProviderManagementSession public facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists an explicit provider order through the session seam', () => {
    const session = new ProviderManagementSession(settings);

    session.saveOrder(['openai', 'openrouter']);

    expect(settings.setPersistent).toHaveBeenCalledWith('providerOrder', ['openai', 'openrouter']);
  });

  it('forwards list() to the provider-service loader and returns its items', () => {
    const items = [{ kind: 'builtin', id: 'openai', label: 'OpenAI' }] as any;
    vi.mocked(loadProviderItems).mockReturnValue(items);
    const session = new ProviderManagementSession(settings);

    expect(session.list()).toBe(items);
    expect(loadProviderItems).toHaveBeenCalledWith(settings);
  });

  it('forwards save() to the provider-service saver with the draft and edit target', () => {
    const result = { ok: true } as any;
    vi.mocked(saveProvider).mockReturnValue(result);
    const session = new ProviderManagementSession(settings);
    const draft = { name: 'custom-provider', baseUrl: 'http://localhost:11434' } as any;

    expect(session.save(draft, 'previous-name')).toBe(result);
    expect(saveProvider).toHaveBeenCalledWith(settings, draft, 'previous-name');
  });

  it('delegates delete() and does not reject an unknown provider id', () => {
    const session = new ProviderManagementSession(settings);

    expect(() => session.delete('missing-provider')).not.toThrow();
    expect(deleteCustomProvider).toHaveBeenCalledWith(settings, 'missing-provider');

    session.delete('custom-provider');
    expect(deleteCustomProvider).toHaveBeenCalledWith(settings, 'custom-provider');
  });
});
