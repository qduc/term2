import { expect, it } from 'vitest';
import { createMockSettingsService } from './settings-service.mock.js';

it.each(['model', 'provider'])('rejects persistent scalar selection child %s without changing the pair', (field) => {
  const settings = createMockSettingsService();
  const before = settings.get('agent.modelSelection');
  expect(() => settings.setPersistentDynamic(`agent.modelSelection.${field}`, 'other')).toThrow(/atomic/);
  expect(settings.get('agent.modelSelection')).toEqual(before);
});

it('rejects scalar selection children even when supplied together in a persistent batch', () => {
  const settings = createMockSettingsService();
  const before = settings.get('agent.modelSelection');
  expect(() => settings.setPersistentDynamicTransaction([
    { key: 'agent.modelSelection.model', value: 'other' },
    { key: 'agent.modelSelection.provider', value: 'other' },
  ])).toThrow(/atomic/);
  expect(settings.get('agent.modelSelection')).toEqual(before);
});

it('publishes a complete runtime pair and rejects incomplete replacement', () => {
  const settings = createMockSettingsService();
  const selection = { model: 'model', provider: 'host' };
  settings.set('agent.modelSelection', selection, { persist: false });
  expect(settings.get('agent.modelSelection')).toEqual(selection);
  expect(() => settings.setDynamic('agent.modelSelection', { model: 'other' })).toThrow();
  expect(settings.get('agent.modelSelection')).toEqual(selection);
});
