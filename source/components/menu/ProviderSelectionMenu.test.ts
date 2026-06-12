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
      fieldErrors: {},
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
        { kind: 'provider', id: 'openai', label: 'OpenAI', isActive: true, isCustom: false },
        { kind: 'provider', id: 'custom-ollama', label: 'custom-ollama', isActive: false, isCustom: true },
        { kind: 'add-provider', label: 'Add Custom Provider' },
      ],
      errorMessage: null,
      fieldErrors: {},
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
      fieldErrors: {},
      selectedProviderName: 'custom-ollama',
      draft: null,
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('× Yes, delete this provider'));
  t.true(frame.includes('No, keep it'));
});

test('ProviderSelectionMenu renders inline field errors in edit_fields', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'edit_fields',
      selectedIndex: 0,
      activeItems: [
        { kind: 'field', label: 'Name: bad name', fieldKey: 'name' },
        { kind: 'field', label: 'Base URL', detail: 'http://localhost:11434/v1', fieldKey: 'baseUrl' },
        { kind: 'action', label: 'Save Changes' },
      ],
      errorMessage: null,
      fieldErrors: {
        name: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
        baseUrl: "Base URL is required for provider type 'openai-compatible'.",
      },
      selectedProviderName: undefined,
      draft: { name: 'bad name', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('⚠ Name must start with a letter or number'));
  t.true(frame.includes("⚠ Base URL is required for provider type 'openai-compatible'."));
});

test('ProviderSelectionMenu renders the confirm discard warning', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'confirm_discard',
      selectedIndex: 1,
      activeItems: [
        { kind: 'action', label: 'Yes, discard changes', tone: 'destructive' },
        { kind: 'action', label: 'No, keep editing' },
      ],
      errorMessage: null,
      fieldErrors: {},
      selectedProviderName: undefined,
      draft: { name: 'test-provider', type: 'openai-compatible' },
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Discard Changes?'));
  t.true(frame.includes('⚠ You have unsaved changes. Discard them?'));
  t.true(frame.includes('No, keep editing'));
});

test('ProviderSelectionMenu renders reorder phase with provider items', (t) => {
  const { lastFrame } = render(
    React.createElement(ProviderSelectionMenu, {
      phase: 'reorder',
      selectedIndex: 0,
      activeItems: [
        { kind: 'reorder-item', id: 'openai', label: 'OpenAI' },
        { kind: 'reorder-item', id: 'openrouter', label: 'OpenRouter' },
        { kind: 'reorder-item', id: 'codex', label: 'Codex' },
      ],
      errorMessage: null,
      fieldErrors: {},
      selectedProviderName: undefined,
      draft: null,
    }),
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Reorder Providers'));
  t.true(frame.includes('OpenAI'));
  t.true(frame.includes('OpenRouter'));
  t.true(frame.includes('Codex'));
});
