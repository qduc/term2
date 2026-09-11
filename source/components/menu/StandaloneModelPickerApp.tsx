import React, { useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import { useStandaloneModelPicker } from '../../hooks/use-standalone-model-picker.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { ILoggingService } from '../../services/service-interfaces.js';
import type { ModelFetcher } from '../../services/models/model-catalog-session.js';
import { COLOR_WARNING } from '../theme.js';

export type StandaloneModelPickerSelection = { modelId: string; provider: string };

export type StandaloneModelPickerOutcome =
  | { status: 'selected'; selection: StandaloneModelPickerSelection }
  | { status: 'cancelled' };

export type StandaloneModelPickerAppProps = {
  settingsService: SettingsService;
  loggingService: ILoggingService;
  modelFetcher?: ModelFetcher;
  /** Filter query the menu opens with (e.g. the pattern typed after --model). */
  initialQuery?: string;
  /** Provider tab the menu opens on (e.g. where the top-ranked match lives). */
  initialProvider?: string;
  /** When set (an explicit --provider), search is scoped to this provider. */
  lockProvider?: string;
  /** One-line explanations shown above the menu (e.g. "No models match ..."). */
  bannerLines?: string[];
  /** Called exactly once after the picker has been asked to unmount. */
  onDone: (outcome: StandaloneModelPickerOutcome) => void;
};

/**
 * Ink root for the pre-app model picker host: drives `ModelSelectionMenu`
 * (the same presentational component the interactive app uses) with its own
 * `useInput` boundary, since there is no composer here to own keys through
 * the app's `MenuSurface`/`MenuController` machinery. Calls `onDone` exactly
 * once and then exits, which the host uses to unmount and restore the
 * terminal before returning control to the caller. Teardown starts before the
 * host is notified so startup actions cannot race the picker close transition.
 */
export function StandaloneModelPickerApp({
  settingsService,
  loggingService,
  modelFetcher,
  initialQuery,
  initialProvider,
  lockProvider,
  bannerLines,
  onDone,
}: StandaloneModelPickerAppProps) {
  const { exit } = useApp();
  const models = useStandaloneModelPicker({
    loggingService,
    settingsService,
    modelFetcher,
    initialQuery,
    initialProvider,
    lockProvider,
  });

  const finish = useCallback(
    (outcome: StandaloneModelPickerOutcome) => {
      exit();
      onDone(outcome);
    },
    [onDone, exit],
  );

  useInput((input, key) => {
    // The inline nickname editor for a favorited row owns text input, Enter,
    // and Escape while it is open, exactly as it does inside the composer's
    // ModelMenuSession: Escape cancels the draft, not the whole picker.
    if (models.nicknameDraft) {
      if (key.return) {
        models.commitNicknameDraft();
      } else if (key.escape) {
        models.cancelNicknameDraft();
      } else if (key.backspace) {
        models.backspaceNicknameDraft();
      } else if (key.ctrl && input.toLowerCase() === 'f') {
        models.toggleFavorite();
      } else if (input && !key.ctrl && !key.meta && !key.tab) {
        models.typeNicknameDraft(input);
      }
      return;
    }

    if (key.escape) {
      finish({ status: 'cancelled' });
      return;
    }
    if (key.upArrow) {
      models.moveUp();
    } else if (key.downArrow) {
      models.moveDown();
    } else if (key.pageUp) {
      models.pageUp();
    } else if (key.pageDown) {
      models.pageDown();
    } else if ((key as { home?: boolean }).home) {
      models.moveHome();
    } else if ((key as { end?: boolean }).end) {
      models.moveEnd();
    } else if (key.tab || key.leftArrow || key.rightArrow) {
      // Tab and the arrows all switch the Favorites/All tab; Tab never
      // completes a model id into a buffer here.
      models.switchModelTab();
    } else if (key.ctrl && input === 'r') {
      models.refresh();
    } else if (key.ctrl && input.toLowerCase() === 'f') {
      models.toggleFavorite();
    } else if (key.ctrl && input.toLowerCase() === 'n') {
      models.startNicknameEdit();
    } else if (key.return) {
      const selected = models.getSelectedItem();
      if (!selected || selected.unavailableReason) return;
      finish({ status: 'selected', selection: { modelId: selected.id, provider: selected.provider } });
    } else if (key.backspace) {
      models.backspaceQuery();
    } else if (key.delete) {
      // Forward-delete has no mid-string cursor to act on here.
    } else if (input && !key.ctrl && !key.meta) {
      models.typeQuery(input);
    }
  });

  return (
    <Box flexDirection="column">
      {bannerLines?.map((line, index) => (
        <Text key={index} color={COLOR_WARNING}>
          {line}
        </Text>
      ))}
      <ModelSelectionMenu
        settingsService={settingsService}
        items={models.filteredModels}
        selectedIndex={models.selectedIndex}
        query={models.query}
        modelTab={models.providerScope ? undefined : models.modelTab}
        provider={models.providerScope}
        loading={models.loading}
        error={models.error}
        warning={models.warning}
        scrollOffset={models.scrollOffset}
        canSwitchProvider={!models.providerScope}
        providerSwitchDisabledMessage={lockProvider ? `Provider fixed by --provider ${lockProvider}` : undefined}
        favoriteKeys={models.favoriteKeys}
        nicknameLabels={models.nicknameLabels}
        nicknameDraft={models.nicknameDraft}
      />
    </Box>
  );
}

export default StandaloneModelPickerApp;
