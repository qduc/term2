import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputContext } from '../context/InputContext.js';
import { useModelSelection } from './use-model-selection.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
import { Text } from 'ink';

const TestComponent = ({ onResults }: { onResults: (results: any) => void }) => {
  const { setMode } = useInputContext();

  useEffect(() => {
    setMode('model_selection');
  }, [setMode]);

  const models = useModelSelection({
    loggingService: { warn: () => {} } as any,
    settingsService: createMockSettingsService({
      'agent.openrouter.apiKey': 'fake-key',
    }),
  });

  useEffect(() => {
    onResults(models);
  }, [models, onResults]);

  return <Text>Provider: {models.provider}</Text>;
};

test('toggleProvider cycles through available providers', async (t) => {
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
