import React, { useEffect, useMemo } from 'react';
import SettingsSelectionMenu from '../menu/SettingsSelectionMenu.js';
import { getModelSettingConfig } from '../../utils/ai/model-settings.js';
import { buildSettingValueSuggestions, isSecretSetting, isStringSetting } from '../../utils/value-suggestions.js';
import { SETTING_KEYS } from '../../services/settings/settings-service.js';
import { SETTINGS_RESET_TRIGGER } from './triggers.js';
import type { useSettingsCompletion } from '../../hooks/use-settings-completion.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { EditorSnapshot, MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';

type SettingsState = ReturnType<typeof useSettingsCompletion>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'settings' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'settings' }>>['services'] & {
    settings: SettingsState;
  };
};

// One transaction: replace the active key range with `<key> ` (plus a seeded
// field draft for free-form string settings), move the cursor to the end, and
// push the settings-backed child (value or model) with a Back that restores
// this exact pre-selection editor snapshot. The controller does not wait for
// trigger detection to rediscover the child — see "Settings parent-to-child
// transition" in the menu redesign plan.
//
// Field seeding (Phase B, D4: free-form strings only): selecting a string
// setting with no curated suggestions opens its value frame as a field
// prefilled with the current value, so a change is an in-place edit rather
// than a full retype. Curated strings keep list navigation (their list is
// still the primary surface) and stored credentials are never echoed back
// into the buffer, so neither seeds. The seeded text is ordinary value text
// from the controller's point of view: reconciliation re-derives the binding
// from the current editor, so only this push-time frame construction differs
// from the unseeded path.
const pushChildEffect = (
  frame: Extract<MenuFrame, { kind: 'settings' }>,
  key: string,
  currentEditor: EditorSnapshot,
  currentValue: unknown,
): MenuEffect => {
  const beforeReplacement = currentEditor.text.slice(0, frame.binding.replacement.start);
  const valuePrefix = `${beforeReplacement}${key} `;

  const modelConfig = getModelSettingConfig(key);
  const isMentorPool = key === SETTING_KEYS.AGENT_MENTOR_POOL;
  const isFreeFormStringSetting =
    !modelConfig &&
    !isMentorPool &&
    isStringSetting(key) &&
    !isSecretSetting(key) &&
    buildSettingValueSuggestions(key).length === 0;
  const seed =
    isFreeFormStringSetting && currentValue !== undefined && currentValue !== null ? String(currentValue) : undefined;

  const nextText = seed === undefined ? valuePrefix : `${valuePrefix}${seed}`;
  const nextCursor = nextText.length;
  // The value region starts after `<key> `; the trigger range and the binding
  // positions must exclude the seed so the seeded text parses as value text
  // (this is what reconciliation would derive from the editor anyway).
  const valueStart = valuePrefix.length;
  const trigger = { range: { start: 0, end: valueStart }, text: valuePrefix };
  const back = { type: 'restore' as const, point: { editor: currentEditor } };

  const childFrame = isMentorPool
    ? {
        kind: 'mentor_pool' as const,
        origin: { type: 'settings-list' as const, operation: 'set' as const, back },
        binding: {
          trigger,
          queryStart: valueStart,
          queryEnd: 'cursor' as const,
          replacement: { start: valueStart, end: 'buffer-end' as const },
        },
      }
    : modelConfig
    ? {
        kind: 'model' as const,
        target: {
          type: 'setting' as const,
          config: {
            modelKey: modelConfig.modelKey,
            providerKey: modelConfig.providerKey,
            fallbackProviderKey: modelConfig.fallbackProviderKey,
          },
        },
        back,
        binding: {
          trigger,
          queryStart: valueStart,
          queryEnd: 'cursor' as const,
          replacement: { start: valueStart, end: 'buffer-end' as const },
        },
      }
    : {
        kind: 'settings_value' as const,
        settingKey: key,
        origin: { type: 'settings-list' as const, operation: 'set' as const, back },
        binding: {
          trigger,
          queryStart: valueStart,
          queryEnd: 'cursor' as const,
          replacement: { start: valueStart, end: 'cursor' as const },
        },
      };

  return {
    buffer: { type: 'replace', text: nextText, cursor: nextCursor },
    stack: { type: 'push', frame: childFrame },
  };
};

export function SettingsMenuSession({ frame, active, controller, interactions, services }: Props) {
  const settings = services.settings;
  const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

  const interaction = useMemo<MenuInteraction>(
    () => ({
      handle: (event) => {
        if (!('type' in event)) return;
        if (event.type === 'input' && event.text === ' ' && frame.operation !== 'reset') {
          const selected = settings.getSelectedItem();
          if (selected && typeof selected.currentValue === 'boolean') {
            return {
              stack: { type: 'keep' },
              intent: {
                id: `apply-settings:${frame.id}:${selected.key}`,
                sourceFrameId: frame.id,
                intent: {
                  type: 'apply-settings',
                  changes: [{ key: selected.key, value: !selected.currentValue, persistence: 'runtime' }],
                },
              },
            };
          }
        }
        if (applyMenuEditorEvent(controller, event, { horizontal: false })) return keep();
        switch (event.type) {
          case 'move':
            if (event.direction === 'up') settings.moveUp();
            else if (event.direction === 'down') settings.moveDown();
            else if (event.direction === 'home') settings.moveHome();
            else if (event.direction === 'end') settings.moveEnd();
            else if (event.direction === 'page-up') settings.pageUp();
            else settings.pageDown();
            return { stack: { type: 'keep' } };
          case 'command':
            if (event.command === 'tab') settings.switchCategory('next');
            else if (event.command === 'left') settings.switchCategory('prev');
            else if (event.command === 'right') settings.switchCategory('next');
            return { stack: { type: 'keep' } };
          case 'accept': {
            const selected = settings.getSelectedItem();
            const currentEditor = controller.getSnapshot().editor;

            if (frame.operation === 'reset') {
              const trimmedQuery = frame.binding.query.trim();
              if (selected && trimmedQuery !== selected.key) {
                // Complete the key text; stay in reset mode for a follow-up
                // acceptance. Reconciliation refreshes this same frame's
                // binding from the new buffer — see the reset-setting
                // grammar note in the menu redesign plan.
                const nextText = `${SETTINGS_RESET_TRIGGER}${selected.key} `;
                return {
                  buffer: { type: 'replace', text: nextText, cursor: nextText.length },
                  stack: { type: 'keep' },
                };
              }
              const candidateKey = selected?.key ?? trimmedQuery;
              const isValidKey = candidateKey && settings.allSettings.some((item) => item.key === candidateKey);
              if (isValidKey) {
                return {
                  buffer: { type: 'clear' },
                  stack: { type: 'close-top' },
                  intent: {
                    id: `reset-setting:${frame.id}`,
                    sourceFrameId: frame.id,
                    intent: { type: 'reset-setting', key: candidateKey },
                  },
                };
              }
              return 'fallthrough';
            }

            if (!selected) return 'fallthrough';
            return pushChildEffect(frame, selected.key, currentEditor, selected.currentValue);
          }
          case 'escape':
            return { buffer: { type: 'clear' }, stack: { type: 'close-top' } };
          default:
            return;
        }
      },
    }),
    [controller, frame, settings],
  );

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <SettingsSelectionMenu
      items={settings.filteredEntries}
      selectedIndex={settings.selectedIndex}
      scrollOffset={settings.scrollOffset}
      query={frame.binding.query}
      isSearchingAll={settings.isSearchingAll}
      activeCategoryId={settings.activeCategoryId}
      categories={settings.categories}
    />
  );
}
