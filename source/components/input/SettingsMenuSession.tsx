import React, { useEffect, useMemo } from 'react';
import SettingsSelectionMenu from '../menu/SettingsSelectionMenu.js';
import { getModelSettingConfig } from '../../utils/ai/model-settings.js';
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

// One transaction: replace the active key range with `<key> `, move the
// cursor after the delimiter, and push the settings-backed child (value or
// model) with a Back that restores this exact pre-selection editor snapshot.
// The controller does not wait for trigger detection to rediscover the
// child — see "Settings parent-to-child transition" in the menu redesign plan.
const pushChildEffect = (
  frame: Extract<MenuFrame, { kind: 'settings' }>,
  key: string,
  currentEditor: EditorSnapshot,
): MenuEffect => {
  const beforeReplacement = currentEditor.text.slice(0, frame.binding.replacement.start);
  const nextText = `${beforeReplacement}${key} `;
  const nextCursor = nextText.length;
  const trigger = { range: { start: 0, end: nextText.length }, text: nextText };
  const back = { type: 'restore' as const, point: { editor: currentEditor } };

  const modelConfig = getModelSettingConfig(key);
  const childFrame = modelConfig
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
          queryStart: nextText.length,
          queryEnd: 'cursor' as const,
          replacement: { start: nextText.length, end: 'buffer-end' as const },
        },
      }
    : {
        kind: 'settings_value' as const,
        settingKey: key,
        origin: { type: 'settings-list' as const, operation: 'set' as const, back },
        binding: {
          trigger,
          queryStart: nextText.length,
          queryEnd: 'cursor' as const,
          replacement: { start: nextText.length, end: 'cursor' as const },
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
            return pushChildEffect(frame, selected.key, currentEditor);
          }
          case 'escape':
            return { stack: { type: 'close-top' } };
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
