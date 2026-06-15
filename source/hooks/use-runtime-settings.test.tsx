import test from 'ava';
// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useRuntimeSettings } from './use-runtime-settings.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

const flushEffects = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test.serial('useRuntimeSettings routes agent.provider changes through switchProvider', async (t) => {
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

  await renderInAct(<Harness />, t);
  await flushEffects();

  t.deepEqual(calls, ['switch:openrouter']);
});
