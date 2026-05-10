import test from 'ava';
import React, { useEffect, useMemo } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { useModelSelection } from './use-model-selection.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { Text } from 'ink';
import { clearModelCache } from '../services/model-service.js';
import { getProviderIds, registerProvider, unregisterProvider } from '../providers/index.js';

type TestComponentProps = {
  onResults: (results: any) => void;
  settingsService?: ReturnType<typeof createMockSettingsService>;
  initialInput?: string;
};

const TestComponent = ({
  onResults,
  settingsService,
  initialInput = '/model deepseek-v4-flash --provider=opencode go',
}: TestComponentProps) => {
  const { setInput, setCursorOffset, setMode, setTriggerIndex } = useInputContext();
  const resolvedSettingsService = useMemo(
    () =>
      settingsService ??
      createMockSettingsService({
        'agent.openrouter.apiKey': 'fake-key',
      }),
    [settingsService],
  );
  const loggingService = useMemo(() => ({ warn: () => {} } as any), []);

  useEffect(() => {
    const input = initialInput;
    setInput(input);
    setCursorOffset(input.length);
    setTriggerIndex('/model '.length);
    setMode('model_selection');
  }, [initialInput, setCursorOffset, setInput, setMode, setTriggerIndex]);

  const models = useModelSelection({
    loggingService,
    settingsService: resolvedSettingsService,
  });

  useEffect(() => {
    onResults(models);
  }, [models, onResults]);

  return <Text>Provider: {models.provider}</Text>;
};

test.serial('toggleProvider cycles through available providers', async (t) => {
  let capturedModels: any;
  render(
    <InputProvider>
      <TestComponent
        onResults={(m) => {
          capturedModels = m;
        }}
      />
    </InputProvider>,
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  const firstProvider = capturedModels.provider;
  t.truthy(firstProvider);

  // Manual toggle
  capturedModels.toggleProvider();

  await new Promise((resolve) => setTimeout(resolve, 50));
  const secondProvider = capturedModels.provider;
  t.not(secondProvider, firstProvider, 'Provider should have switched');

  // Toggle back or to next
  capturedModels.toggleProvider();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const thirdProvider = capturedModels.provider;
  t.not(thirdProvider, secondProvider, 'Provider should have switched again');
});

test.serial('model selection query strips provider suffix from input', async (t) => {
  let capturedModels: any;
  render(
    <InputProvider>
      <TestComponent
        onResults={(m) => {
          capturedModels = m;
        }}
      />
    </InputProvider>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  t.is(capturedModels.query, 'deepseek-v4-flash');
});

test.serial('ignores stale model results after switching providers', async (t) => {
  clearModelCache();

  const firstProvider = `slow-provider-${Date.now()}-${Math.random()}`;
  const secondProvider = `fast-provider-${Date.now()}-${Math.random()}`;
  let resolveFirst: (() => void) | undefined;

  registerProvider({
    id: firstProvider,
    label: firstProvider,
    fetchModels: async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return [{ id: 'slow-model', name: 'Slow Model' }];
    },
  });
  registerProvider({
    id: secondProvider,
    label: secondProvider,
    fetchModels: async () => [{ id: 'fast-model', name: 'Fast Model' }],
  });

  t.teardown(() => {
    clearModelCache();
    unregisterProvider(firstProvider);
    unregisterProvider(secondProvider);
  });

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.provider': firstProvider,
  });

  render(
    <InputProvider>
      <TestComponent
        settingsService={settingsService}
        initialInput="/model "
        onResults={(m) => {
          capturedModels = m;
        }}
      />
    </InputProvider>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  t.is(capturedModels.provider, firstProvider);

  capturedModels.toggleProvider();
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.is(capturedModels.provider, secondProvider);
  t.deepEqual(
    capturedModels.filteredModels.map((model: any) => model.id),
    ['fast-model'],
  );

  resolveFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 50));

  t.is(capturedModels.provider, secondProvider);
  t.deepEqual(
    capturedModels.filteredModels.map((model: any) => model.id),
    ['fast-model'],
  );
});

test.serial('keeps completed provider results ready when switching back', async (t) => {
  clearModelCache();

  const firstProvider = `return-slow-provider-${Date.now()}-${Math.random()}`;
  const secondProvider = `return-fast-provider-${Date.now()}-${Math.random()}`;
  let resolveFirst: (() => void) | undefined;

  registerProvider({
    id: firstProvider,
    label: firstProvider,
    fetchModels: async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      return [{ id: 'slow-model', name: 'Slow Model' }];
    },
  });
  registerProvider({
    id: secondProvider,
    label: secondProvider,
    fetchModels: async () => [{ id: 'fast-model', name: 'Fast Model' }],
  });

  t.teardown(() => {
    clearModelCache();
    unregisterProvider(firstProvider);
    unregisterProvider(secondProvider);
  });

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.provider': firstProvider,
  });

  render(
    <InputProvider>
      <TestComponent
        settingsService={settingsService}
        initialInput="/model "
        onResults={(m) => {
          capturedModels = m;
        }}
      />
    </InputProvider>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  capturedModels.toggleProvider();
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.is(capturedModels.provider, secondProvider);
  t.deepEqual(
    capturedModels.filteredModels.map((model: any) => model.id),
    ['fast-model'],
  );

  resolveFirst?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  t.deepEqual(
    capturedModels.filteredModels.map((model: any) => model.id),
    ['fast-model'],
  );

  for (let i = 0; i < getProviderIds().length && capturedModels.provider !== firstProvider; i++) {
    capturedModels.toggleProvider();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  t.is(capturedModels.provider, firstProvider);
  t.deepEqual(
    capturedModels.filteredModels.map((model: any) => model.id),
    ['slow-model'],
  );
});
