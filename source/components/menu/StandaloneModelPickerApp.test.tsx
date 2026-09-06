import React, { act } from 'react';
import { expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { registerProvider, unregisterProvider } from '../../providers/index.js';
import { clearModelCache } from '../../services/model-service.js';
import { toggleFavoriteModel } from '../../services/models/model-favorites.js';
import StandaloneModelPickerApp, { type StandaloneModelPickerOutcome } from './StandaloneModelPickerApp.js';

const noopLoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
} as any;

let providerId: string;
let providerModels: Array<{ id: string; name?: string }>;

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  clearModelCache();
  providerId = `mock-provider-${Date.now()}-${Math.random()}`;
  providerModels = [
    { id: 'gpt-5.4', name: 'GPT 5.4' },
    { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
  ];
  registerProvider({
    id: providerId,
    label: 'Mock Provider',
    fetchModels: async () => providerModels,
  });
});

afterEach(() => {
  unregisterProvider(providerId);
  vi.unstubAllEnvs();
});

/** Sends a chunk of raw stdin bytes and lets effects/microtasks settle inside act(). */
const send = async (stdin: { write: (data: string) => void }, data: string) => {
  await act(async () => {
    stdin.write(data);
    await Promise.resolve();
    await Promise.resolve();
  });
};

/**
 * Ink buffers a lone Escape byte for `pendingInputFlushDelayMilliseconds`
 * (20ms in Ink 7) before flushing it as `key.escape`, since a bare ESC is
 * indistinguishable from the start of a longer CSI sequence until either
 * more bytes arrive or that window elapses. A real timer wait is required;
 * awaiting only microtasks resolves before Ink's flush fires.
 */
const sendEscapeAndWait = async (stdin: { write: (data: string) => void }) => {
  await act(async () => {
    stdin.write('');
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
};

it('resolves with the selected model and its home provider on Enter', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  let outcome: StandaloneModelPickerOutcome | undefined;

  const { stdin } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      onDone={(o) => (outcome = o)}
    />,
  );

  await send(stdin, '\r');

  expect(outcome).toEqual({ status: 'selected', selection: { modelId: 'gpt-5.4', provider: providerId } });
});

it('filters the list as the user types the seeded query further', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  let outcome: StandaloneModelPickerOutcome | undefined;

  const { stdin, lastFrame } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      initialQuery="gpt-5.4"
      onDone={(o) => (outcome = o)}
    />,
  );

  expect(lastFrame()).toContain('gpt-5.4');
  expect(lastFrame()).toContain('gpt-5.4-mini');

  await send(stdin, '-m');
  await send(stdin, 'i');
  await send(stdin, 'n');
  await send(stdin, 'i');

  await send(stdin, '\r');

  expect(outcome).toEqual({ status: 'selected', selection: { modelId: 'gpt-5.4-mini', provider: providerId } });
});

it('cancels on Escape without selecting anything', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  let outcome: StandaloneModelPickerOutcome | undefined;

  const { stdin } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      onDone={(o) => (outcome = o)}
    />,
  );

  await sendEscapeAndWait(stdin);

  expect(outcome).toEqual({ status: 'cancelled' });
});

it('locks the tab and shows the fixed-provider message when lockProvider is set', async () => {
  const otherProvider = `${providerId}-other`;
  registerProvider({ id: otherProvider, label: 'Other', fetchModels: async () => [{ id: 'other-model' }] });
  try {
    const settingsService = createMockSettingsService({ 'agent.provider': otherProvider });
    const { lastFrame, stdin } = await renderInAct(
      <StandaloneModelPickerApp
        settingsService={settingsService}
        loggingService={noopLoggingService}
        lockProvider={providerId}
        onDone={() => {}}
      />,
    );

    expect(lastFrame()).toContain('Provider fixed by --provider ' + providerId);

    // Attempting to switch tabs is a no-op: the model list still comes from
    // the locked provider, not the one configured in settings.
    await send(stdin, '[C'); // right arrow
    expect(lastFrame()).toContain('gpt-5.4');
  } finally {
    unregisterProvider(otherProvider);
  }
});

it('renders banner lines above the menu', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  const { lastFrame } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      bannerLines={['No models match "zzz".']}
      onDone={() => {}}
    />,
  );

  expect(lastFrame()).toContain('No models match "zzz".');
});

it('toggling a favorite with ctrl+f persists it to settings', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  const { stdin } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      onDone={() => {}}
    />,
  );

  await send(stdin, '\x06'); // ctrl+f

  expect(settingsService.get('agent.favoriteModels')).toEqual([`${providerId}/gpt-5.4`]);
});

it('does not select an item flagged unavailable', async () => {
  const otherProvider = `${providerId}-locked`;
  // isRuntimeDefined + no stored/env credential forces
  // resolveProviderCredentials to report required-but-missing, which is what
  // makes the hook render the configured model as an unavailable row instead
  // of fetching a catalog.
  registerProvider({ id: otherProvider, label: 'Locked', isRuntimeDefined: true, fetchModels: async () => [] });
  try {
    const settingsService = createMockSettingsService({
      'agent.provider': otherProvider,
      'agent.model': 'configured-model',
    });
    let outcome: StandaloneModelPickerOutcome | undefined;
    const { stdin, lastFrame } = await renderInAct(
      <StandaloneModelPickerApp
        settingsService={settingsService}
        loggingService={noopLoggingService}
        onDone={(o) => (outcome = o)}
      />,
    );

    expect(lastFrame()).toContain('unavailable');

    await send(stdin, '\r');
    expect(outcome).toBeUndefined();
  } finally {
    unregisterProvider(otherProvider);
  }
});

it('opens on the Favorites tab and resolves the row real provider when favorited', async () => {
  const settingsService = createMockSettingsService({ 'agent.provider': providerId });
  toggleFavoriteModel(settingsService, providerId, 'gpt-5.4');
  let outcome: StandaloneModelPickerOutcome | undefined;

  const { stdin } = await renderInAct(
    <StandaloneModelPickerApp
      settingsService={settingsService}
      loggingService={noopLoggingService}
      onDone={(o) => (outcome = o)}
    />,
  );

  await send(stdin, '\r');

  expect(outcome).toEqual({ status: 'selected', selection: { modelId: 'gpt-5.4', provider: providerId } });
});
