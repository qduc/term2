// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import ProviderSelectionMenu from './ProviderSelectionMenu.js';

test.serial('ProviderSelectionMenu shows the type step numbering consistently', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Step 2: Provider Type'));
});

test.serial('ProviderSelectionMenu renders structured provider items without built-in/custom suffixes', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('OpenAI'));
  t.true(frame.includes('Add Custom Provider'));
  t.false(frame.includes('(built-in)'));
  t.false(frame.includes('(custom)'));
});

test.serial('ProviderSelectionMenu highlights destructive delete confirmation text', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('× Yes, delete this provider'));
  t.true(frame.includes('No, keep it'));
});

test.serial('ProviderSelectionMenu renders inline field errors in edit_fields', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('⚠ Name must start with a letter or number'));
  t.true(frame.includes("⚠ Base URL is required for provider type 'openai-compatible'."));
});

test.serial('ProviderSelectionMenu renders the confirm discard warning', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Discard Changes?'));
  t.true(frame.includes('⚠ You have unsaved changes. Discard them?'));
  t.true(frame.includes('No, keep editing'));
});

test.serial('ProviderSelectionMenu renders reorder phase with provider items', async (t) => {
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
    t,
  );

  const frame = lastFrame()!;
  t.true(frame.includes('Reorder Providers'));
  t.true(frame.includes('OpenAI'));
  t.true(frame.includes('OpenRouter'));
  t.true(frame.includes('Codex'));
});
