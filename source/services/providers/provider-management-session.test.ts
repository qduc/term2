import { expect, it, vi } from 'vitest';
import { ProviderManagementSession } from './provider-management-session.js';

it('keeps provider persistence and deletion behind one session seam', () => {
  const settings = {
    get: vi.fn(() => 'openai'),
    getDynamic: vi.fn(() => []),
    setPersistent: vi.fn(),
    setPersistentDynamic: vi.fn(),
  } as any;
  const session = new ProviderManagementSession(settings);

  session.saveOrder(['openai', 'openrouter']);

  expect(settings.setPersistent).toHaveBeenCalledWith('providerOrder', ['openai', 'openrouter']);
  expect(() => session.delete('missing-provider')).not.toThrow();
});
