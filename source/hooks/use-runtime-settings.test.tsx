import test from 'ava';
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useRuntimeSettings } from './use-runtime-settings.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('useRuntimeSettings routes agent.provider changes through switchProvider', async (t) => {
  const calls: string[] = [];
  const settingsService = createMockSettingsService({
    'agent.provider': 'openai',
  });
  const conversationService = {
    switchProvider(provider: string) {
      calls.push(`switch:${provider}`);
    },
    setProvider(provider: string) {
      calls.push(`set:${provider}`);
    },
    queueModeNotice() {},
  } as any;

  const Harness = () => {
    const applyRuntimeSetting = useRuntimeSettings({
      setModel: () => {},
      setReasoningEffort: () => {},
      setTemperature: () => {},
      conversationService,
      settingsService,
    });

    useEffect(() => {
      applyRuntimeSetting('agent.provider', 'openrouter');
    }, [applyRuntimeSetting]);

    return <Text>runtime</Text>;
  };

  const app = render(<Harness />);
  await flushEffects();

  t.deepEqual(calls, ['switch:openrouter']);

  app.unmount();
});
