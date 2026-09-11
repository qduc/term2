import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import ModelSelectionMenu from '../menu/ModelSelectionMenu.js';
import { computeModelInsertion } from './insertions.js';
import type { useModelSelection } from '../../hooks/use-model-selection.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';
import { resolveProviderCredentials } from '../../utils/ai/provider-credentials.js';
import { COLOR_DANGER } from '../theme.js';

type ModelsState = ReturnType<typeof useModelSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'model' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'model' }>>['services'] & {
    models: ModelsState;
    settingsService: SettingsService;
  };
};

export function ModelMenuSession({ frame, active, controller, interactions, services }: Props) {
  const models = services.models;
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const settingsService = services.settingsService;
  const [applyError, setApplyError] = useState<string | null>(null);

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

    const resolvedModelId = (): string | undefined => {
      const current = modelsRef.current;
      const selected = current.getSelectedItem();
      const typed = current.query.trim();
      return selected?.id ?? (typed || undefined);
    };

    const effectiveProvider = (): string | null | undefined => {
      const current = modelsRef.current;
      const selectedProvider = current.getSelectedItem()?.provider;
      if (selectedProvider) return selectedProvider;
      const providerKey = current.modelSettingConfig?.providerKey ?? 'agent.provider';
      const configured = settingsService.getDynamic(providerKey);
      return typeof configured === 'string' ? configured : null;
    };

    return {
      handle: (event) => {
        const models = modelsRef.current;
        if (!('type' in event)) {
          // Correlated IntentResult for the apply-settings/submit-prompt
          // intent this frame issued.
          if (event.ok) {
            return { stack: { type: 'close-top' } };
          }
          setApplyError(event.message);
          return keep();
        }

        // While the inline nickname editor owns the input row, it is the
        // single consumer for text keys, Enter, and Escape:
        // printable input and backspace edit the draft instead of the filter
        // query, Enter commits — or keeps the editor open with the rejection
        // reason — and Escape cancels back to the untouched filter row rather
        // than closing the menu, so a second Escape closes the menu as usual.
        // ctrl+f stays live: it toggles the highlighted row's favorite.
        // Tab, refresh, reset, and list navigation are deliberately
        // suspended: the editor is bound
        // to one highlighted row, so navigating away would orphan it.
        if (models.nicknameDraft) {
          switch (event.type) {
            case 'input':
              models.typeNicknameDraft(event.text);
              return keep();
            case 'command':
              if (event.command === 'backspace') models.backspaceNicknameDraft();
              else if (event.command === 'favorite') models.toggleFavorite();
              return keep();
            case 'move':
              return keep();
            case 'accept':
              models.commitNicknameDraft();
              return keep();
            case 'escape':
              models.cancelNicknameDraft();
              return keep();
            default:
              return keep();
          }
        }

        // Tab and the horizontal arrows all switch the Favorites/All tab. Tab
        // deliberately does not complete the highlighted model id into the
        // composer: it is the user's key for moving between tabs, and Enter
        // already selects.
        if (
          event.type === 'command' &&
          (event.command === 'tab' || event.command === 'left' || event.command === 'right')
        ) {
          models.switchModelTab();
          return keep();
        }

        if (applyMenuEditorEvent(controller, event, { horizontal: false })) return keep();

        switch (event.type) {
          case 'move':
            setApplyError(null);
            if (event.direction === 'up') models.moveUp();
            else if (event.direction === 'down') models.moveDown();
            else if (event.direction === 'home') models.moveHome();
            else if (event.direction === 'end') models.moveEnd();
            else if (event.direction === 'page-up') models.pageUp();
            else models.pageDown();
            return keep();
          case 'command': {
            setApplyError(null);
            if (event.command === 'refresh') models.refresh();
            else if (event.command === 'favorite') models.toggleFavorite();
            else if (event.command === 'nickname') models.startNicknameEdit();
            return keep();
          }
          case 'accept': {
            setApplyError(null);
            const modelId = resolvedModelId();
            if (!modelId) return 'fallthrough';

            const resolvedProvider = effectiveProvider();
            const unavailable = resolvedProvider
              ? resolveProviderCredentials(settingsService, resolvedProvider).unavailableReason
              : undefined;
            const selectedUnavailable = models.getSelectedItem()?.unavailableReason;
            if (unavailable || selectedUnavailable) {
              const requestSetup = services.onUnavailableModelSelected as ((provider: string) => void) | undefined;
              requestSetup?.(resolvedProvider ?? settingsService.get('agent.provider'));
              return keep();
            }

            if (frame.target.type === 'setting') {
              const { config } = frame.target;
              const provider = resolvedProvider;
              const persistenceFor = (key: string) =>
                settingsService.isRuntimeModifiable(key) ? 'runtime' : 'restart';
              const changes: { key: string; value: unknown; persistence: 'runtime' | 'restart' }[] = [
                { key: config.modelKey, value: modelId, persistence: persistenceFor(config.modelKey) },
              ];
              if (provider) {
                changes.push({
                  key: config.providerKey,
                  value: provider,
                  persistence: persistenceFor(config.providerKey),
                });
              }
              return {
                stack: { type: 'keep' },
                intent: {
                  id: `apply-settings:${frame.id}`,
                  sourceFrameId: frame.id,
                  intent: { type: 'apply-settings', changes },
                },
              };
            }

            const currentEditor = controller.getSnapshot().editor;
            const insertion = computeModelInsertion({
              selection: models.getSelectedItem(),
              modelId,
              triggerIndex: frame.binding.replacement.start,
              provider: resolvedProvider,
              value: currentEditor.text,
              appendTrailingSpace: false,
              includeProvider: true,
            });
            if (!insertion) return 'fallthrough';
            return {
              buffer: { type: 'clear' },
              stack: { type: 'close-top' },
              intent: {
                id: `submit:${frame.id}`,
                sourceFrameId: frame.id,
                intent: { type: 'submit-prompt', text: insertion.nextValue },
              },
            };
          }
          case 'escape':
            return { stack: { type: 'close-top' } };
          default:
            return;
        }
      },
    };
  }, [controller, frame, services.onUnavailableModelSelected, settingsService]);

  useEffect(() => {
    if (!active) return;
    return interactions.register(frame.id, interaction);
  }, [active, frame.id, interaction, interactions]);

  if (!active) return null;
  return (
    <Box flexDirection="column">
      <ModelSelectionMenu
        settingsService={settingsService}
        items={models.filteredModels}
        selectedIndex={models.selectedIndex}
        query={models.query}
        modelTab={models.modelTab}
        loading={models.loading}
        error={models.error}
        warning={models.warning}
        scrollOffset={models.scrollOffset}
        credentialRevision={models.credentialRevision}
        favoriteKeys={models.favoriteKeys}
        nicknameLabels={models.nicknameLabels}
        nicknameDraft={models.nicknameDraft}
      />
      {applyError && <Text color={COLOR_DANGER}>{applyError}</Text>}
    </Box>
  );
}
