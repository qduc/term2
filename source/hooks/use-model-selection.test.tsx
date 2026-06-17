import { it, expect } from 'vitest';
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act, useEffect, useMemo, useRef } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { useModelSelection } from './use-model-selection.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { Text } from 'ink';
import { clearModelCache } from '../services/model-service.js';
import { getProviderIds, registerProvider } from '../providers/index.js';

type TestComponentProps = {
  onResults: (results: any) => void;
  settingsService?: ReturnType<typeof createMockSettingsService>;
  initialInput?: string;
};

type ImmediateToggleComponentProps = {
  onResults: (results: any) => void;
  settingsService?: ReturnType<typeof createMockSettingsService>;
};

const flush = async (callback: () => void) => {
  await act(async () => {
    callback();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const waitForIdle = async (getModels: () => any) => {
  for (let i = 0; i < 20 && getModels()?.loading; i++) {
    await flush(() => {});
  }
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
    let triggerLen = '/model '.length;
    if (input.startsWith('/settings ')) {
      const spaceIdx = input.indexOf(' ', '/settings '.length);
      triggerLen = spaceIdx >= 0 ? spaceIdx + 1 : input.length;
    }
    setTriggerIndex(triggerLen);
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

const ImmediateToggleComponent = ({ onResults, settingsService }: ImmediateToggleComponentProps) => {
  const { setInput, setCursorOffset } = useInputContext();
  const resolvedSettingsService = useMemo(
    () =>
      settingsService ??
      createMockSettingsService({
        'agent.openrouter.apiKey': 'fake-key',
      }),
    [settingsService],
  );
  const loggingService = useMemo(() => ({ warn: () => {} } as any), []);

  const models = useModelSelection({
    loggingService,
    settingsService: resolvedSettingsService,
  });
  const didToggleRef = useRef(false);

  useEffect(() => {
    if (didToggleRef.current) return;
    didToggleRef.current = true;
    const input = '/model ';
    setInput(input);
    setCursorOffset(input.length);
    models.open(input.length);
    models.toggleProvider('prev');
  }, [models, setCursorOffset, setInput]);

  useEffect(() => {
    onResults(models);
  }, [models, onResults]);

  return <Text>Provider: {models.provider}</Text>;
};

it.sequential('toggleProvider cycles through available providers', async () => {
  let capturedModels: any;
  let renderer: any;
  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  const firstProvider = capturedModels.provider;
  expect(firstProvider).toBeTruthy();

  // Manual toggle
  await flush(() => {
    capturedModels.toggleProvider();
  });
  await waitForIdle(() => capturedModels);

  const secondProvider = capturedModels.provider;
  expect(secondProvider, 'Provider should have switched').not.toBe(firstProvider);

  // Toggle back or to next
  await flush(() => {
    capturedModels.toggleProvider();
  });
  await waitForIdle(() => capturedModels);
  const thirdProvider = capturedModels.provider;
  expect(thirdProvider, 'Provider should have switched again').not.toBe(secondProvider);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('toggleProvider supports prev and next direction', async () => {
  let capturedModels: any;
  let renderer: any;
  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  const firstProvider = capturedModels.provider;
  expect(firstProvider).toBeTruthy();

  // Toggle prev should switch to the last provider
  await flush(() => {
    capturedModels.toggleProvider('prev');
  });
  await waitForIdle(() => capturedModels);

  const lastProvider = capturedModels.provider;
  expect(lastProvider, 'Provider should have switched to previous/last').not.toBe(firstProvider);

  // Toggle next should switch back to the first provider
  await flush(() => {
    capturedModels.toggleProvider('next');
  });
  await waitForIdle(() => capturedModels);
  expect(capturedModels.provider, 'Provider should have switched back to first').toBe(firstProvider);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('toggleProvider uses the configured provider immediately after opening', async () => {
  const providerIds = getProviderIds();
  expect(providerIds.length > 1).toBe(true);

  let capturedModels: any;
  const configuredProvider = providerIds[1];
  const expectedPrevious = providerIds[0];
  const settingsService = createMockSettingsService({
    'agent.provider': configuredProvider,
    'agent.openrouter.apiKey': 'fake-key',
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
      <InputProvider>
        <ImmediateToggleComponent
          settingsService={settingsService}
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(expectedPrevious);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('exposes modelSettingConfig for settings-backed triggers', async () => {
  let capturedModels: any;
  clearModelCache();
  const testProvider = `setting-backed-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: testProvider,
    label: testProvider,
    fetchModels: (() => []) as any,
  });

  const settingsService = createMockSettingsService({
    'agent.provider': testProvider,
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          settingsService={settingsService}
          initialInput="/settings agent.model "
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });

  await waitForIdle(() => capturedModels);

  expect(capturedModels.modelSettingConfig).toBeTruthy();
  expect(capturedModels.modelSettingConfig.modelKey).toBe('agent.model');
  expect(capturedModels.modelSettingConfig.providerKey).toBe('agent.provider');

  await flush(() => {
    renderer.unmount();
  });
  for (let i = 0; i < 5; i++) {
    await flush(() => {});
  }
});

it.sequential('modelSettingConfig is undefined for command-backed triggers', async () => {
  let capturedModels: any;
  clearModelCache();
  const testProvider = `command-backed-provider-${Date.now()}-${Math.random()}`;
  registerProvider({
    id: testProvider,
    label: testProvider,
    fetchModels: (() => []) as any,
  });

  const settingsService = createMockSettingsService({
    'agent.provider': testProvider,
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          settingsService={settingsService}
          initialInput="/model gpt-4"
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });

  await waitForIdle(() => capturedModels);

  expect(capturedModels.modelSettingConfig).toBe(undefined);

  await flush(() => {
    renderer.unmount();
  });
  for (let i = 0; i < 5; i++) {
    await flush(() => {});
  }
});

it.sequential('model selection query strips provider suffix from input', async () => {
  let capturedModels: any;
  let renderer: any;
  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.query).toBe('deepseek-v4-flash');

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('ignores stale model results after switching providers', async () => {
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

  // cleanup handled inline (unique providers don't conflict)

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.provider': firstProvider,
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
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
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(firstProvider);

  await flush(() => {
    capturedModels.toggleProvider();
  });
  await waitForIdle(() => capturedModels);
  expect(capturedModels.provider).toBe(secondProvider);
  expect(capturedModels.filteredModels.map((model: any) => model.id)).toEqual(['fast-model']);

  await flush(() => {
    resolveFirst?.();
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(secondProvider);
  expect(capturedModels.filteredModels.map((model: any) => model.id)).toEqual(['fast-model']);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('keeps completed provider results ready when switching back', async () => {
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

  // cleanup handled inline (unique providers don't conflict)

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.provider': firstProvider,
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
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
  });
  await waitForIdle(() => capturedModels);

  await flush(() => {
    capturedModels.toggleProvider();
  });
  await waitForIdle(() => capturedModels);
  expect(capturedModels.provider).toBe(secondProvider);
  expect(capturedModels.filteredModels.map((model: any) => model.id)).toEqual(['fast-model']);

  await flush(() => {
    resolveFirst?.();
  });
  await waitForIdle(() => capturedModels);
  expect(capturedModels.filteredModels.map((model: any) => model.id)).toEqual(['fast-model']);

  for (let i = 0; i < getProviderIds().length && capturedModels.provider !== firstProvider; i++) {
    await flush(() => {
      capturedModels.toggleProvider();
    });
    await waitForIdle(() => capturedModels);
  }

  expect(capturedModels.provider).toBe(firstProvider);
  expect(capturedModels.filteredModels.map((model: any) => model.id)).toEqual(['slow-model']);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('pre-selects the current model of the setting it is changing (command-backed)', async () => {
  clearModelCache();

  const testProvider = `test-provider-${Date.now()}-${Math.random()}`;
  const modelsList = [
    { id: 'model-a', name: 'Model A' },
    { id: 'model-b', name: 'Model B' },
    { id: 'model-c', name: 'Model C' },
  ];

  registerProvider({
    id: testProvider,
    label: testProvider,
    fetchModels: (() => modelsList) as any,
  });

  // cleanup handled inline (unique providers don't conflict)

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.provider': testProvider,
    'agent.model': 'model-b',
    'agent.openrouter.apiKey': 'fake-key',
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
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
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(testProvider);
  expect(capturedModels.selectedIndex).toBe(1);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('pre-selects the current model of the setting it is changing (settings-backed)', async () => {
  clearModelCache();

  const testProvider = `test-provider-mentor-${Date.now()}-${Math.random()}`;
  const modelsList = [
    { id: 'mentor-1', name: 'Mentor 1' },
    { id: 'mentor-2', name: 'Mentor 2' },
    { id: 'mentor-3', name: 'Mentor 3' },
  ];

  registerProvider({
    id: testProvider,
    label: testProvider,
    fetchModels: (() => modelsList) as any,
  });

  // cleanup handled inline (unique providers don't conflict)

  let capturedModels: any;
  const settingsService = createMockSettingsService({
    'agent.mentorProvider': testProvider,
    'agent.mentorModel': 'mentor-3',
    'agent.openrouter.apiKey': 'fake-key',
  });
  let renderer: any;

  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          settingsService={settingsService}
          initialInput="/settings agent.mentorModel "
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(testProvider);
  expect(capturedModels.selectedIndex).toBe(2);

  await flush(() => {
    renderer.unmount();
  });
});

it.sequential('allows switching the main provider even when conversation history exists', async () => {
  clearModelCache();

  const firstProvider = `history-provider-a-${Date.now()}-${Math.random()}`;
  const secondProvider = `history-provider-b-${Date.now()}-${Math.random()}`;

  registerProvider({
    id: firstProvider,
    label: firstProvider,
    fetchModels: async () => [{ id: 'model-a', name: 'Model A' }],
  });
  registerProvider({
    id: secondProvider,
    label: secondProvider,
    fetchModels: async () => [{ id: 'model-b', name: 'Model B' }],
  });

  // cleanup handled inline (unique providers don't conflict)

  let capturedModels: any;
  let renderer: any;
  const settingsService = createMockSettingsService({
    'agent.provider': firstProvider,
    'agent.model': 'model-a',
  });

  await flush(() => {
    renderer = render(
      <InputProvider>
        <TestComponent
          settingsService={settingsService}
          initialInput="/settings agent.model "
          onResults={(m) => {
            capturedModels = m;
          }}
        />
      </InputProvider>,
    );
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.canSwitchProvider).toBe(true);
  expect(capturedModels.provider).toBe(firstProvider);

  await flush(() => {
    capturedModels.toggleProvider();
  });
  await waitForIdle(() => capturedModels);

  expect(capturedModels.provider).toBe(secondProvider);

  await flush(() => {
    renderer.unmount();
  });
});
