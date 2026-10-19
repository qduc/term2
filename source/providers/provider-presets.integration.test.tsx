// @ts-expect-error React act environment flag
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputProvider } from '../context/InputContext.js';
import { MenuControllerImpl } from '../components/input/menu-controller.js';
import ProviderSelectionMenu from '../components/menu/ProviderSelectionMenu.js';
import { useProviderSelection } from '../hooks/use-provider-selection.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { renderInAct } from '../test-helpers/ink-testing.js';
import { PROVIDER_PRESETS, parseProviderInventory } from './provider-presets.js';
import { getProvider, unregisterProvider } from './index.js';
import { orderedProviderIds } from '../services/models/model-catalog-session.js';

let directory: string;
let settings: SettingsService;
let selection: ReturnType<typeof useProviderSelection>;
const created = new Set<string>();

beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENROUTER_API_KEY', '');
  directory = mkdtempSync(join(tmpdir(), 'term2-provider-presets-'));
  settings = new SettingsService({ settingsDir: directory, disableLogging: true, disableFilePersistence: false });
});

afterEach(() => {
  for (const id of created) unregisterProvider(id);
  created.clear();
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function Harness() {
  selection = useProviderSelection(settings);
  return <ProviderSelectionMenu {...selection} activeItems={selection.getActiveItems()} />;
}

async function start() {
  const controller = new MenuControllerImpl();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <Harness />
    </InputProvider>,
  );
  await act(async () => {
    controller.open({ kind: 'providers' });
  });
  return view;
}

async function highlight(label: string) {
  const index = selection.getActiveItems().findIndex((item) => item.label === label);
  expect(index, `menu item ${label}`).toBeGreaterThanOrEqual(0);
  while (selection.selectedIndex !== index) {
    await act(async () => {
      selection.moveDown();
    });
  }
}

async function choose(label: string) {
  await highlight(label);
  await act(async () => {
    selection.selectItem();
  });
}

it('copies inventory defaults into independent editable connections and reloads them from disk', async () => {
  const view = await start();
  expect(selection.items.some((item) => ['openai', 'openrouter'].includes(item.id))).toBe(false);
  expect(view.lastFrame()).toContain('Your Providers');
  await choose('Add Provider');
  expect(selection.phase).toBe('presets');
  const labels = selection
    .getActiveItems()
    .filter((item) => item.kind === 'preset')
    .map((item) => item.label);
  expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
  expect(labels).toContain('OpenAI');
  expect(labels).toContain('OpenRouter');
  await choose('Ollama (local)');
  expect(selection.draft).toMatchObject({
    name: 'ollama',
    type: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  expect(view.lastFrame()).toContain('Review & Save Provider');
  expect(view.lastFrame()).not.toContain('Disable Provider');
  await choose('Save Changes');
  created.add('ollama');
  expect(selection.items.find((item) => item.id === 'ollama')).toMatchObject({ isCustom: true, hasCredentials: true });
  expect(orderedProviderIds(settings, ['openai', 'openrouter', 'ollama'])).toEqual(['ollama']);

  await choose('Add Provider');
  await choose('Ollama (local)');
  expect(selection.draft?.name).toBe('ollama-2');
  await choose('Name: ollama-2');
  await act(async () => {
    selection.handleTextInputSubmit('my-local');
  });
  await choose('Base URL');
  await act(async () => {
    selection.handleTextInputSubmit('http://127.0.0.1:12345/v1');
  });
  await choose('Save Changes');
  created.add('my-local');
  const reloaded = new SettingsService({ settingsDir: directory, disableLogging: true, disableFilePersistence: false });
  expect(reloaded.getDynamic('providers')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }),
      expect.objectContaining({ id: 'my-local', baseUrl: 'http://127.0.0.1:12345/v1' }),
    ]),
  );
  expect(PROVIDER_PRESETS.find((preset) => preset.id === 'ollama')?.baseUrl).toBe('http://127.0.0.1:11434/v1');

  await choose('my-local');
  await choose('Disable Provider');
  expect(orderedProviderIds(settings, ['my-local', 'ollama'])).toEqual(['ollama']);
  await highlight('my-local');
  await act(async () => {
    selection.requestDelete();
  });
  await choose('Yes, delete this provider');
  expect(selection.items.some((item) => item.id === 'my-local')).toBe(false);
});

it('keeps native OpenAI/OpenRouter credentials and identity while allowing setup through the inventory', async () => {
  const originalOpenAI = getProvider('openai');
  const originalOpenRouter = getProvider('openrouter');
  const view = await start();
  await choose('Add Provider');
  await choose('OpenRouter');
  expect(selection.phase).toBe('wizard_key');
  await act(async () => {
    selection.handleTextInputSubmit('fixture-key-not-real');
  });
  await choose('Save Changes');
  expect(selection.items.find((item) => item.id === 'openrouter')?.hasCredentials).toBe(true);
  expect(view.lastFrame()).toContain('OpenRouter');
  expect(getProvider('openai')).toBe(originalOpenAI);
  expect(getProvider('openrouter')).toBe(originalOpenRouter);
  const persisted = JSON.parse(readFileSync(join(directory, 'settings.json'), 'utf8'));
  expect(persisted.agent.openrouter.apiKey).toBe('fixture-key-not-real');
  expect(persisted.providers ?? []).toHaveLength(0);
  const reloaded = new SettingsService({ settingsDir: directory, disableLogging: true, disableFilePersistence: false });
  expect(reloaded.get('agent.openrouter.apiKey')).toBe('fixture-key-not-real');
  await choose('Add Provider');
  await choose('OpenRouter');
  await act(async () => {
    selection.goBack();
  });
  expect(selection.phase).toBe('edit_fields');
  await choose('API Key');
  await act(async () => {
    selection.handleTextInputSubmit('');
  });
  await choose('Save Changes');
  const preserved = new SettingsService({
    settingsDir: directory,
    disableLogging: true,
    disableFilePersistence: false,
  });
  expect(preserved.get('agent.openrouter.apiKey')).toBe('fixture-key-not-real');
});

it('preserves manual setup, rejects invalid input, and leaves no connection when cancelled', async () => {
  await start();
  await choose('Add Provider');
  await choose('Custom endpoint');
  expect(selection.phase).toBe('wizard_name');
  await act(async () => {
    selection.handleTextInputSubmit('bad name!');
  });
  expect(selection.errorMessage).toBeTruthy();
  await act(async () => {
    selection.handleTextInputSubmit('manual-fixture');
  });
  await choose('openai-compatible');
  await act(async () => {
    selection.handleTextInputSubmit('not-a-url');
  });
  expect(selection.phase).toBe('wizard_url');
  expect(selection.errorMessage).toContain('Invalid URL');
  await act(async () => {
    selection.handleTextInputSubmit('http://127.0.0.1:9999/v1');
  });
  await act(async () => {
    selection.handleTextInputSubmit('');
  });
  await choose('Cancel');
  expect(selection.items.some((item) => item.id === 'manual-fixture')).toBe(false);
  expect(settings.getDynamic('providers') ?? []).toHaveLength(0);
  expect(() => parseProviderInventory({ schemaVersion: 2, presets: [] })).toThrow();
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === 'ollama')!;
  expect(() => parseProviderInventory({ schemaVersion: 1, presets: [preset, preset] })).toThrow();
  expect(() => parseProviderInventory({ schemaVersion: 1, presets: [{ ...preset, type: 'unsupported' }] })).toThrow();
});
