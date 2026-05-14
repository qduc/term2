import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import StatusBar from './StatusBar.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';

test('StatusBar renders reasoning effort on the first row with the model', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'agent.reasoningEffort': 'low',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = render(<StatusBar settingsService={settingsService} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('gpt-4o'));
  t.true(output.includes('(low)'));
  t.false(output.includes('Reasoning:'));
  t.true(output.split('\n').some((line) => line.includes('gpt-4o') && line.includes('(low)')));
});
