import { afterEach, beforeEach, it, expect, vi } from 'vitest';
// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, useMemo } from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useStandaloneModelPicker } from './use-standalone-model-picker.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { FAVORITES_TAB_ID, toggleFavoriteModel } from '../services/models/model-favorites.js';

type TestModelFetcher = (provider: string) => Promise<any[]>;

const testProviderIds = new Set<string>();
const registerTestProvider = (definition: Parameters<typeof registerProvider>[0]) => {
  testProviderIds.add(definition.id);
  registerProvider(definition);
};

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
});

afterEach(() => {
  for (const providerId of testProviderIds) unregisterProvider(providerId);
  testProviderIds.clear();
  vi.unstubAllEnvs();
});

const flush = async (callback: () => void) => {
  await act(async () => {
    callback();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const waitForIdle = async (getState: () => any) => {
  for (let i = 0; i < 20 && getState()?.loading; i++) {
    await flush(() => {});
  }
};

type TestComponentProps = {
  onResults: (results: any) => void;
  settingsService: ReturnType<typeof createMockSettingsService>;
  initialQuery?: string;
  lockProvider?: string;
  modelFetcher?: TestModelFetcher;
};

const TestComponent = ({
  onResults,
  settingsService,
  initialQuery,
  lockProvider,
  modelFetcher,
}: TestComponentProps) => {
  const loggingService = useMemo(() => ({ warn: () => {} } as any), []);
  const state = useStandaloneModelPicker({
    loggingService,
    settingsService,
    modelFetcher,
    initialQuery,
    lockProvider,
  });
  onResults(state);
  return <Text>picker</Text>;
};

it('opens on the Favorites tab when favorites exist', async () => {
  const testProvider = `test-fav-${Math.random().toString(36).slice(2)}`;
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: (async () => []) as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });
  toggleFavoriteModel(settingsService, testProvider, 'fav-model');

  let captured: any;
  await flush(() => {
    render(<TestComponent settingsService={settingsService} onResults={(r) => (captured = r)} />);
  });

  expect(captured.provider).toBe(FAVORITES_TAB_ID);
  expect(captured.filteredModels).toEqual([{ id: 'fav-model', provider: testProvider }]);
});

it('falls back to agent.provider when there are no favorites', async () => {
  const testProvider = `test-plain-${Math.random().toString(36).slice(2)}`;
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: (async () => []) as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });

  let captured: any;
  await flush(() => {
    render(<TestComponent settingsService={settingsService} onResults={(r) => (captured = r)} />);
  });

  expect(captured.provider).toBe(testProvider);
});

it('locks the provider tab and disables switching when lockProvider is given', async () => {
  const providerA = `test-a-${Math.random().toString(36).slice(2)}`;
  const providerB = `test-b-${Math.random().toString(36).slice(2)}`;
  registerTestProvider({ id: providerA, label: providerA, fetchModels: (async () => []) as any });
  registerTestProvider({ id: providerB, label: providerB, fetchModels: (async () => []) as any });
  const settingsService = createMockSettingsService({ 'agent.provider': providerA });

  let captured: any;
  await flush(() => {
    render(
      <TestComponent settingsService={settingsService} lockProvider={providerB} onResults={(r) => (captured = r)} />,
    );
  });

  expect(captured.provider).toBe(providerB);
  expect(captured.canSwitchProvider).toBe(false);

  await flush(() => captured.toggleProvider('next'));
  expect(captured.provider).toBe(providerB);
});

it('seeds the query from initialQuery and filters loaded models against it', async () => {
  const testProvider = `test-query-${Math.random().toString(36).slice(2)}`;
  const fetcher: TestModelFetcher = async () => [
    { id: 'gpt-5.4', provider: testProvider },
    { id: 'claude', provider: testProvider },
  ];
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: fetcher as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });

  let captured: any;
  await flush(() => {
    render(
      <TestComponent
        settingsService={settingsService}
        initialQuery="gpt"
        modelFetcher={fetcher}
        onResults={(r) => (captured = r)}
      />,
    );
  });
  await waitForIdle(() => captured);

  expect(captured.query).toBe('gpt');
  expect(captured.filteredModels.map((m: any) => m.id)).toEqual(['gpt-5.4']);
});

it('typeQuery and backspaceQuery update the query incrementally', async () => {
  const testProvider = `test-type-${Math.random().toString(36).slice(2)}`;
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: (async () => []) as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });

  let captured: any;
  await flush(() => {
    render(<TestComponent settingsService={settingsService} onResults={(r) => (captured = r)} />);
  });

  await flush(() => captured.typeQuery('g'));
  await flush(() => captured.typeQuery('pt'));
  expect(captured.query).toBe('gpt');

  await flush(() => captured.backspaceQuery());
  expect(captured.query).toBe('gp');
});

it('moveDown wraps to the first item past the last', async () => {
  const testProvider = `test-nav-${Math.random().toString(36).slice(2)}`;
  const fetcher: TestModelFetcher = async () => [
    { id: 'a', provider: testProvider },
    { id: 'b', provider: testProvider },
  ];
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: fetcher as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });

  let captured: any;
  await flush(() => {
    render(
      <TestComponent settingsService={settingsService} modelFetcher={fetcher} onResults={(r) => (captured = r)} />,
    );
  });
  await waitForIdle(() => captured);

  expect(captured.selectedIndex).toBe(0);
  await flush(() => captured.moveDown());
  expect(captured.selectedIndex).toBe(1);
  await flush(() => captured.moveDown());
  expect(captured.selectedIndex).toBe(0);
});

it('toggleFavorite persists the currently selected model as a favorite', async () => {
  const testProvider = `test-favtoggle-${Math.random().toString(36).slice(2)}`;
  const fetcher: TestModelFetcher = async () => [{ id: 'model-x', provider: testProvider }];
  registerTestProvider({ id: testProvider, label: testProvider, fetchModels: fetcher as any });
  const settingsService = createMockSettingsService({ 'agent.provider': testProvider });

  let captured: any;
  await flush(() => {
    render(
      <TestComponent settingsService={settingsService} modelFetcher={fetcher} onResults={(r) => (captured = r)} />,
    );
  });
  await waitForIdle(() => captured);

  expect(captured.favoriteKeys.size).toBe(0);
  await flush(() => captured.toggleFavorite());
  expect(settingsService.get('agent.favoriteModels')).toEqual([`${testProvider}/model-x`]);
});
