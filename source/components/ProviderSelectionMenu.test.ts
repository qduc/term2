import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import ProviderSelectionMenu from './ProviderSelectionMenu.js';

test('ProviderSelectionMenu shows the type step numbering consistently', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'wizard_type',
      selectedIndex: 0,
      activeItems: [
        { kind: 'type', label: 'openai-compatible' },
        { kind: 'type', label: 'openai' },
      ],
      errorMessage: null,
      selectedProviderName: undefined,
      draft: { name: 'local', type: 'openai-compatible' },
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Step 2: Provider Type'));
});

test('ProviderSelectionMenu renders structured provider items without built-in/custom suffixes', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'list',
      selectedIndex: 0,
      activeItems: [
        { kind: 'provider', id: 'openai', label: 'OpenAI', isActive: true },
        { kind: 'provider', id: 'custom-ollama', label: 'custom-ollama', isActive: false },
        { kind: 'add-provider', label: 'Add Custom Provider' },
      ],
      errorMessage: null,
      selectedProviderName: undefined,
      draft: null,
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('OpenAI'));
  t.true(frame.includes('Add Custom Provider'));
  t.false(frame.includes('(built-in)'));
  t.false(frame.includes('(custom)'));
});

test('ProviderSelectionMenu highlights destructive delete confirmation text', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'confirm_delete',
      selectedIndex: 0,
      activeItems: [
        { kind: 'action', label: 'Yes, delete this provider', tone: 'destructive' },
        { kind: 'action', label: 'No, keep it' },
      ],
      errorMessage: null,
      selectedProviderName: 'custom-ollama',
      draft: null,
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('× Yes, delete this provider'));
  t.true(frame.includes('No, keep it'));
});
