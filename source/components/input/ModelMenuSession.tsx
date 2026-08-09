import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import ModelSelectionMenu from '../menu/ModelSelectionMenu.js';
import { computeModelInsertion } from './insertions.js';
import type { useModelSelection } from '../../hooks/use-model-selection.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { MenuComponentProps } from './menu-registry.js';
import type { MenuEffect, MenuFrame, MenuInteraction } from './menu-types.js';
import { applyMenuEditorEvent } from './menu-editor.js';
import { resolveProviderCredentials } from '../../utils/ai/provider-credentials.js';

type ModelsState = ReturnType<typeof useModelSelection>;

type Props = MenuComponentProps<Extract<MenuFrame, { kind: 'model' }>> & {
  services: MenuComponentProps<Extract<MenuFrame, { kind: 'model' }>>['services'] & {
    models: ModelsState;
    settingsService: SettingsService;
  };
};

export function ModelMenuSession({ frame, active, controller, interactions, services }: Props) {
  const models = services.models;
  const settingsService = services.settingsService;
  const [applyError, setApplyError] = useState<string | null>(null);

  const interaction = useMemo<MenuInteraction>(() => {
    const keep = (): MenuEffect => ({ stack: { type: 'keep' } });

    const resolvedModelId = (): string | undefined => {
      const selected = models.getSelectedItem();
      const typed = models.query.trim();
      return selected?.id ?? (typed || undefined);
    };

    return {
      handle: (event) => {
        if (!('type' in event)) {
          // Correlated IntentResult for the apply-settings/submit-prompt
          // intent this frame issued.
          if (event.ok) {
            return { stack: { type: 'close-top' } };
          }
          setApplyError(event.message);
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
            if (event.command === 'tab') {
              const modelId = resolvedModelId();
              const currentEditor = controller.getSnapshot().editor;
              const insertion = computeModelInsertion({
                selection: models.getSelectedItem(),
                modelId,
                triggerIndex: frame.binding.replacement.start,
                provider: models.provider,
                value: currentEditor.text,
                appendTrailingSpace: true,
                includeProvider: false,
              });
              if (!insertion) return keep();
              return {
                buffer: { type: 'replace', text: insertion.nextValue, cursor: insertion.nextCursor },
                stack: { type: 'keep' },
              };
            }
            if (event.command === 'left') models.toggleProvider('prev');
            else if (event.command === 'right') models.toggleProvider('next');
            else if (event.command === 'refresh') models.refresh();
            return keep();
          }
          case 'accept': {
            setApplyError(null);
            const modelId = resolvedModelId();
            if (!modelId) return 'fallthrough';

            const unavailable = models.provider
              ? resolveProviderCredentials(settingsService, models.provider).unavailableReason
              : undefined;
            const selectedUnavailable = models.getSelectedItem()?.unavailableReason;
            if (unavailable || selectedUnavailable) {
              const requestSetup = services.onUnavailableModelSelected as ((provider: string) => void) | undefined;
              requestSetup?.(models.provider ?? settingsService.get('agent.provider'));
              return keep();
            }

            if (frame.target.type === 'setting') {
              const { config } = frame.target;
              const provider = models.provider;
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
              provider: models.provider,
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
  }, [controller, frame, models, settingsService]);

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
        provider={models.provider}
        loading={models.loading}
        error={models.error}
        scrollOffset={models.scrollOffset}
        canSwitchProvider={models.canSwitchProvider}
        credentialRevision={models.credentialRevision}
      />
      {applyError && <Text color="red">{applyError}</Text>}
    </Box>
  );
}
