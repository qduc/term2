// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import ProviderSelectionMenu from './ProviderSelectionMenu.js';

it.sequential('ProviderSelectionMenu shows the type step numbering consistently', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="wizard_type"
      selectedIndex={0}
      activeItems={[
        { kind: 'type', label: 'openai-compatible' },
        { kind: 'type', label: 'openai' },
      ]}
      errorMessage={null}
      fieldErrors={{}}
      selectedProviderName={undefined}
      draft={{ name: 'local', type: 'openai-compatible' }}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('Step 2: Provider Type')).toBe(true);
});

it.sequential('ProviderSelectionMenu renders structured provider items without built-in/custom suffixes', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="list"
      selectedIndex={0}
      activeItems={[
        { kind: 'provider', id: 'openai', label: 'OpenAI', isActive: true, isCustom: false },
        { kind: 'provider', id: 'custom-ollama', label: 'custom-ollama', isActive: false, isCustom: true },
        { kind: 'add-provider', label: 'Add Custom Provider' },
      ]}
      errorMessage={null}
      fieldErrors={{}}
      selectedProviderName={undefined}
      draft={null}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('OpenAI')).toBe(true);
  expect(frame.includes('Add Custom Provider')).toBe(true);
  expect(frame.includes('(built-in)')).toBe(false);
  expect(frame.includes('(custom)')).toBe(false);
});

it.sequential('ProviderSelectionMenu highlights destructive delete confirmation text', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="confirm_delete"
      selectedIndex={0}
      activeItems={[
        { kind: 'action', label: 'Yes, delete this provider', tone: 'destructive' },
        { kind: 'action', label: 'No, keep it' },
      ]}
      errorMessage={null}
      fieldErrors={{}}
      selectedProviderName="custom-ollama"
      draft={null}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('× Yes, delete this provider')).toBe(true);
  expect(frame.includes('No, keep it')).toBe(true);
});

it.sequential('ProviderSelectionMenu renders inline field errors in edit_fields', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="edit_fields"
      selectedIndex={0}
      activeItems={[
        { kind: 'field', label: 'Name: bad name', fieldKey: 'name' },
        { kind: 'field', label: 'Base URL', detail: 'http://localhost:11434/v1', fieldKey: 'baseUrl' },
        { kind: 'action', label: 'Save Changes' },
      ]}
      errorMessage={null}
      fieldErrors={{
        name: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
        baseUrl: "Base URL is required for provider type 'openai-compatible'.",
      }}
      selectedProviderName={undefined}
      draft={{ name: 'bad name', type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' }}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('⚠ Name must start with a letter or number')).toBe(true);
  expect(frame.includes("⚠ Base URL is required for provider type 'openai-compatible'.")).toBe(true);
});

it.sequential('ProviderSelectionMenu renders the confirm discard warning', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="confirm_discard"
      selectedIndex={1}
      activeItems={[
        { kind: 'action', label: 'Yes, discard changes', tone: 'destructive' },
        { kind: 'action', label: 'No, keep editing' },
      ]}
      errorMessage={null}
      fieldErrors={{}}
      selectedProviderName={undefined}
      draft={{ name: 'test-provider', type: 'openai-compatible' }}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('Discard Changes?')).toBe(true);
  expect(frame.includes('⚠ You have unsaved changes. Discard them?')).toBe(true);
  expect(frame.includes('No, keep editing')).toBe(true);
});

it.sequential('ProviderSelectionMenu renders reorder phase with provider items', async () => {
  const { lastFrame } = await renderInAct(
    <ProviderSelectionMenu
      phase="reorder"
      selectedIndex={0}
      activeItems={[
        { kind: 'reorder-item', id: 'openai', label: 'OpenAI' },
        { kind: 'reorder-item', id: 'openrouter', label: 'OpenRouter' },
        { kind: 'reorder-item', id: 'codex', label: 'Codex' },
      ]}
      errorMessage={null}
      fieldErrors={{}}
      selectedProviderName={undefined}
      draft={null}
    />,
  );

  const frame = lastFrame()!;
  expect(frame.includes('Reorder Providers')).toBe(true);
  expect(frame.includes('OpenAI')).toBe(true);
  expect(frame.includes('OpenRouter')).toBe(true);
  expect(frame.includes('Codex')).toBe(true);
});
