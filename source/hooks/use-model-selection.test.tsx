import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, useEffect, useMemo } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { registerProvider, unregisterProvider } from '../providers/index.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { useModelSelection } from './use-model-selection.js';

type Settings = ReturnType<typeof createMockSettingsService>;
type ModelFetcher = (provider: string) => Promise<any[]>;
const testProviderIds = new Set<string>();

const registerTestProvider = (id: string) => {
  testProviderIds.add(id);
  registerProvider({ id, label: id, fetchModels: async () => [] });
};

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
});

afterEach(() => {
  for (const id of testProviderIds) unregisterProvider(id);
  testProviderIds.clear();
  vi.unstubAllEnvs();
});

const flush = async (callback: () => void = () => {}) => {
  await act(async () => {
    callback();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const waitForIdle = async (getState: () => any) => {
  for (let i = 0; i < 5; i += 1) await flush();
  for (let i = 0; i < 30 && getState()?.loading; i += 1) await flush();
};

function TestComponent({
  onState,
  settings,
  input = '/model ',
  fetcher,
}: {
  onState: (state: ReturnType<typeof useModelSelection>) => void;
  settings: Settings;
  input?: string;
  fetcher: ModelFetcher;
}) {
  const { setInput, setCursorOffset } = useInputContext();
  const loggingService = useMemo(() => ({ warn: vi.fn() } as any), []);
  const state = useModelSelection({ settingsService: settings, loggingService, modelFetcher: fetcher });

  useEffect(() => {
    setInput(input);
    setCursorOffset(input.length);
  }, [setCursorOffset, setInput, input]);

  useEffect(() => {
    onState(state);
  }, [onState, state]);
  return <Text>{state.filteredModels.length}</Text>;
}

async function renderPicker(options: { settings: Settings; input?: string; fetcher: ModelFetcher }) {
  let state!: ReturnType<typeof useModelSelection>;
  let renderer!: ReturnType<typeof render>;
  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          {...options}
          onState={(next) => {
            state = next;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => state);
  return {
    get state() {
      return state;
    },
    renderer,
  };
}

it.sequential('loads configured provider catalogs into one unified result list', async () => {
  const one = `unified-one-${Math.random()}`;
  const two = `unified-two-${Math.random()}`;
  registerTestProvider(one);
  registerTestProvider(two);
  const settings = createMockSettingsService({ providerOrder: [one, two], 'agent.provider': one });
  const picker = await renderPicker({
    settings,
    fetcher: async (provider) => (provider === one ? [{ id: 'alpha' }] : provider === two ? [{ id: 'beta' }] : []),
  });

  expect(picker.state.provider).toBeNull();
  expect(picker.state.filteredModels).toEqual([
    expect.objectContaining({ id: 'alpha', provider: one }),
    expect.objectContaining({ id: 'beta', provider: two }),
  ]);
  picker.renderer.unmount();
});

it.sequential('filters the unified list by model and --provider query', async () => {
  const one = `filter-one-${Math.random()}`;
  const two = `filter-two-${Math.random()}`;
  registerTestProvider(one);
  registerTestProvider(two);
  const settings = createMockSettingsService({ providerOrder: [one, two] });
  const picker = await renderPicker({
    settings,
    input: `/model shared --provider=${two}`,
    fetcher: async (provider) => [{ id: 'shared', provider }],
  });

  expect(picker.state.query).toBe('shared');
  expect(picker.state.filteredModels).toEqual([expect.objectContaining({ id: 'shared', provider: two })]);
  picker.renderer.unmount();
});

it.sequential('keeps fast provider results visible while another catalog is still loading', async () => {
  const slow = `slow-${Math.random()}`;
  const fast = `fast-${Math.random()}`;
  registerTestProvider(slow);
  registerTestProvider(fast);
  let resolveSlow!: (models: any[]) => void;
  const settings = createMockSettingsService({ providerOrder: [slow, fast] });
  let state!: ReturnType<typeof useModelSelection>;
  let renderer!: ReturnType<typeof render>;
  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          settings={settings}
          fetcher={(provider) =>
            provider === slow
              ? new Promise((resolve) => {
                  resolveSlow = resolve;
                })
              : Promise.resolve(provider === fast ? [{ id: 'ready' }] : [])
          }
          onState={(next) => {
            state = next;
          }}
        />
      </InputProvider>,
    );
  });
  for (let i = 0; i < 5; i += 1) await flush();

  expect(state.loading).toBe(true);
  expect(state.filteredModels).toContainEqual(expect.objectContaining({ id: 'ready', provider: fast }));

  await flush(() => resolveSlow([{ id: 'later' }]));
  await waitForIdle(() => state);
  expect(state.filteredModels).toContainEqual(expect.objectContaining({ id: 'later', provider: slow }));
  renderer.unmount();
});

it.sequential('retains the configured model as unavailable when its provider has no credentials', async () => {
  const unavailable = `unavailable-${Math.random()}`;
  testProviderIds.add(unavailable);
  registerProvider({ id: unavailable, label: unavailable, isRuntimeDefined: true, fetchModels: async () => [] });
  const settings = createMockSettingsService({
    'agent.provider': unavailable,
    'agent.model': 'configured-model',
  });
  const fetcher = vi.fn(async () => []);
  const picker = await renderPicker({ settings, fetcher });

  expect(fetcher).not.toHaveBeenCalledWith(unavailable);
  expect(picker.state.filteredModels).toContainEqual(
    expect.objectContaining({
      id: 'configured-model',
      provider: unavailable,
      unavailableReason: 'missing-credentials',
    }),
  );
  picker.renderer.unmount();
});

it.sequential('preselects the configured provider and model when ids collide', async () => {
  const one = `collision-one-${Math.random()}`;
  const two = `collision-two-${Math.random()}`;
  registerTestProvider(one);
  registerTestProvider(two);
  const settings = createMockSettingsService({
    providerOrder: [one, two],
    'agent.provider': two,
    'agent.model': 'shared',
  });
  const picker = await renderPicker({ settings, fetcher: async () => [{ id: 'shared' }] });

  expect(picker.state.getSelectedItem()).toEqual(expect.objectContaining({ id: 'shared', provider: two }));
  picker.renderer.unmount();
});

it.sequential('exposes setting-specific model and provider keys', async () => {
  const provider = `setting-${Math.random()}`;
  registerTestProvider(provider);
  const settings = createMockSettingsService({ 'agent.provider': provider });
  const picker = await renderPicker({
    settings,
    input: '/settings agent.smartModel ',
    fetcher: async () => [],
  });

  expect(picker.state.modelSettingConfig).toMatchObject({
    modelKey: 'agent.smartModel',
    providerKey: 'agent.smartProvider',
  });
  picker.renderer.unmount();
});

it.sequential('pins favorites and toggles the highlighted model without changing source', async () => {
  const provider = `favorite-${Math.random()}`;
  registerTestProvider(provider);
  const settings = createMockSettingsService({
    providerOrder: [provider],
    'agent.provider': provider,
    'agent.model': 'beta',
    'agent.favoriteModels': [`${provider}/beta`],
  });
  const picker = await renderPicker({
    settings,
    fetcher: async (id) => (id === provider ? [{ id: 'alpha' }, { id: 'beta', name: 'Beta' }] : []),
  });

  expect(picker.state.filteredModels[0]).toEqual(expect.objectContaining({ id: 'beta', provider, name: 'Beta' }));
  await flush(() => picker.state.toggleFavorite());
  expect(settings.get('agent.favoriteModels')).toEqual([]);
  expect(picker.state.filteredModels.map((model) => model.id)).toEqual(['alpha', 'beta']);
  picker.renderer.unmount();
});

it.sequential('edits nicknames only for favorited rows and closes when the favorite is removed', async () => {
  const provider = `nickname-${Math.random()}`;
  registerTestProvider(provider);
  const settings = createMockSettingsService({
    providerOrder: [provider],
    'agent.provider': provider,
    'agent.model': 'favorite',
    'agent.favoriteModels': [`${provider}/favorite`],
  });
  const picker = await renderPicker({
    settings,
    fetcher: async (id) => (id === provider ? [{ id: 'favorite' }, { id: 'ordinary' }] : []),
  });

  await flush(() => picker.state.startNicknameEdit());
  expect(picker.state.nicknameDraft).toMatchObject({ provider, modelId: 'favorite' });
  await flush(() => picker.state.typeNicknameDraft('fav'));
  await flush(() => picker.state.commitNicknameDraft());
  expect(settings.get('agent.modelNicknames')).toEqual({ fav: `${provider}/favorite` });

  await flush(() => picker.state.startNicknameEdit());
  await flush(() => picker.state.toggleFavorite());
  expect(picker.state.nicknameDraft).toBeNull();
  picker.renderer.unmount();
});
