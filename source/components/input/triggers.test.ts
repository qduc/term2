import { describe, expect, it } from 'vitest';
import { createDefaultTriggerRegistry, SETTINGS_TRIGGER } from './triggers.js';
import type { SlashCommand } from '../../slash-commands.js';
import { MODEL_SETTING_TRIGGERS } from '../../utils/ai/model-settings.js';

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Select model',
  expectsArgs: true,
  completion: { type: 'model', trigger: '/model ' },
  action: () => {},
};

const effortCommand: SlashCommand = {
  name: 'effort',
  description: 'Reasoning effort',
  expectsArgs: true,
  completion: { type: 'setting-value', trigger: '/effort ', settingKey: 'agent.reasoningEffort' },
  action: () => {},
};

const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'Settings',
  expectsArgs: true,
  completion: { type: 'settings', trigger: '/settings ', resetTrigger: '/settings reset ' },
  action: () => {},
};

const commands = [modelCommand, effortCommand, settingsCommand];

const editorFor = (text: string, cursor = text.length) => ({ text, cursor, revision: 1 });

describe('Phase 4 rule-id split (graph 3 vs graph 4)', () => {
  it('the settings rule declares successors by the split graph-3 ids', () => {
    const registry = createDefaultTriggerRegistry(commands, ['settings', 'settings-value-child', 'settings-model']);
    const settingsRule = registry.getRule('settings');
    expect(settingsRule).toBeDefined();
    expect(settingsRule?.successors.map((s) => s.ruleId).sort()).toEqual(['settings-model', 'settings-value-child']);
  });

  it('enabling only the graph-3 ids leaves graph-4 triggers unmatched', () => {
    const registry = createDefaultTriggerRegistry(commands, ['settings', 'settings-value-child', 'settings-model']);

    // `/model ` (command-backed) is graph 4 — command-model is disabled.
    expect(registry.parse(editorFor('/model gpt'))).toBeNull();
    // `/effort ` (direct setting-value trigger) is graph 4 — direct-setting-value is disabled.
    expect(registry.parse(editorFor('/effort '))).toBeNull();
  });

  it('enabling only the graph-3 ids matches graph-3 triggers', () => {
    const registry = createDefaultTriggerRegistry(commands, ['settings', 'settings-value-child', 'settings-model']);

    const settingsMatch = registry.parse(editorFor('/settings '));
    expect(settingsMatch?.rule.id).toBe('settings');

    const modelTrigger = MODEL_SETTING_TRIGGERS[0]!;
    const modelMatch = registry.parse(editorFor(`${modelTrigger}gpt`));
    expect(modelMatch?.rule.id).toBe('settings-model');
    expect(modelMatch?.candidate.frame.kind).toBe('model');
    if (modelMatch?.candidate.frame.kind === 'model') {
      expect(modelMatch.candidate.frame.target.type).toBe('setting');
    }

    const valueMatch = registry.parse(editorFor('/settings shell.timeout '));
    expect(valueMatch?.rule.id).toBe('settings-value-child');
    expect(valueMatch?.candidate.frame.kind).toBe('settings_value');
    if (valueMatch?.candidate.frame.kind === 'settings_value') {
      expect(valueMatch.candidate.frame.origin.type).toBe('settings-list');
    }
  });

  it('enabling only the graph-4 ids matches graph-4 triggers and leaves graph-3 unmatched', () => {
    const registry = createDefaultTriggerRegistry(commands, ['command-model', 'direct-setting-value']);

    expect(registry.parse(editorFor('/settings '))).toBeNull();
    const modelTrigger = MODEL_SETTING_TRIGGERS[0]!;
    expect(registry.parse(editorFor(`${modelTrigger}gpt`))).toBeNull();

    const modelMatch = registry.parse(editorFor('/model gpt'));
    expect(modelMatch?.rule.id).toBe('command-model');
    if (modelMatch?.candidate.frame.kind === 'model') {
      expect(modelMatch.candidate.frame.target.type).toBe('command');
      expect(modelMatch.candidate.frame.back).toEqual({ type: 'close-clear-input' });
    }

    const valueMatch = registry.parse(editorFor('/effort '));
    expect(valueMatch?.rule.id).toBe('direct-setting-value');
    if (valueMatch?.candidate.frame.kind === 'settings_value') {
      expect(valueMatch.candidate.frame.origin).toEqual({
        type: 'direct-trigger',
        triggerId: 'agent.reasoningEffort',
        back: { type: 'close-clear-input' },
      });
    }
  });

  it('a passively-typed settings-model activation restores the bare settings prefix, not the typed key', () => {
    const registry = createDefaultTriggerRegistry(commands, ['settings', 'settings-value-child', 'settings-model']);
    const modelTrigger = MODEL_SETTING_TRIGGERS[0]!;
    const match = registry.parse(editorFor(`${modelTrigger}gpt`));
    if (match?.candidate.frame.kind !== 'model') throw new Error('expected a model frame');
    expect(match.candidate.frame.back).toEqual({
      type: 'restore',
      point: { editor: { text: SETTINGS_TRIGGER, cursor: SETTINGS_TRIGGER.length, revision: 1 } },
    });
  });

  it('a passively-typed settings-value-child activation restores the bare settings prefix, not the typed key', () => {
    const registry = createDefaultTriggerRegistry(commands, ['settings', 'settings-value-child', 'settings-model']);
    const match = registry.parse(editorFor('/settings shell.timeout '));
    if (match?.candidate.frame.kind !== 'settings_value') throw new Error('expected a settings_value frame');
    expect(match.candidate.frame.origin).toEqual({
      type: 'settings-list',
      operation: 'set',
      back: {
        type: 'restore',
        point: { editor: { text: SETTINGS_TRIGGER, cursor: SETTINGS_TRIGGER.length, revision: 1 } },
      },
    });
  });
});
