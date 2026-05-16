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

test('StatusBar renders cache usage in the footer', (t) => {
  const settingsService = createMockSettingsService({
    'agent.model': 'gpt-4o',
    'agent.provider': 'openai',
    'shell.autoApproveMode': 'off',
  });

  const { lastFrame } = render(
    <StatusBar
      settingsService={settingsService}
      lastUsage={{ prompt_tokens: 1200, completion_tokens: 350, cache_read_tokens: 900, cache_creation_tokens: 120 }}
    />,
  );

  const output = lastFrame() ?? '';

  t.true(output.includes('Tok: 1,200 in (900 cached, 120 cache write) / 350 out'));
});
