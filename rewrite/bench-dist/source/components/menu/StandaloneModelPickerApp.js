import React, { useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import ModelSelectionMenu from './ModelSelectionMenu.js';
import { useStandaloneModelPicker } from '../../hooks/use-standalone-model-picker.js';
import { useTheme } from '../theme.js';
/**
 * Ink root for the pre-app model picker host: drives `ModelSelectionMenu`
 * (the same presentational component the interactive app uses) with its own
 * `useInput` boundary, since there is no composer here to own keys through
 * the app's `MenuSurface`/`MenuController` machinery. Calls `onDone` exactly
 * once, which lets the host clear the transient frame before unmounting and
 * restoring the terminal.
 */
function StandaloneModelPickerApp({ settingsService, loggingService, modelFetcher, initialQuery, initialProvider, lockProvider, bannerLines, onDone, }) {
    const theme = useTheme();
    const models = useStandaloneModelPicker({
        loggingService,
        settingsService,
        modelFetcher,
        initialQuery,
        initialProvider,
        lockProvider,
    });
    const finish = useCallback((outcome) => {
        onDone(outcome);
    }, [onDone]);
    useInput((input, key) => {
        // The inline nickname editor for a favorited row owns text input, Enter,
        // and Escape while it is open, exactly as it does inside the composer's
        // ModelMenuSession: Escape cancels the draft, not the whole picker.
        if (models.nicknameDraft) {
            if (key.return) {
                models.commitNicknameDraft();
            }
            else if (key.escape) {
                models.cancelNicknameDraft();
            }
            else if (key.backspace) {
                models.backspaceNicknameDraft();
            }
            else if (key.delete) {
                models.removeNicknameDraft();
            }
            else if (key.ctrl && input.toLowerCase() === 'f') {
                models.toggleFavorite();
            }
            else if (input && !key.ctrl && !key.meta && !key.tab) {
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
        }
        else if (key.downArrow) {
            models.moveDown();
        }
        else if (key.pageUp) {
            models.pageUp();
        }
        else if (key.pageDown) {
            models.pageDown();
        }
        else if (key.home) {
            models.moveHome();
        }
        else if (key.end) {
            models.moveEnd();
        }
        else if (key.tab || key.leftArrow || key.rightArrow) {
            // Tab and Right advance; Left moves backward through Favorites/Nicknames/All. Tab never
            // completes a model id into a buffer here.
            models.switchModelTab(key.leftArrow ? 'previous' : 'next');
        }
        else if (key.ctrl && input === 'r') {
            models.refresh();
        }
        else if (key.ctrl && input.toLowerCase() === 'f') {
            models.toggleFavorite();
        }
        else if (key.ctrl && input.toLowerCase() === 'n') {
            models.startNicknameEdit();
        }
        else if (key.return) {
            const selected = models.getSelectedItem();
            if (!selected || selected.unavailableReason)
                return;
            finish({ status: 'selected', selection: { modelId: selected.id, provider: selected.provider } });
        }
        else if (key.backspace) {
            models.backspaceQuery();
        }
        else if (key.delete) {
            // Forward-delete has no mid-string cursor to act on here.
        }
        else if (input && !key.ctrl && !key.meta) {
            models.typeQuery(input);
        }
    });
    return (React.createElement(Box, { flexDirection: "column" },
        bannerLines?.map((line, index) => (React.createElement(Text, { key: index, color: theme.warning }, line))),
        React.createElement(ModelSelectionMenu, { settingsService: settingsService, items: models.filteredModels, selectedIndex: models.selectedIndex, query: models.query, modelTab: models.providerScope ? undefined : models.modelTab, provider: models.providerScope, loading: models.loading, error: models.error, warning: models.warning, scrollOffset: models.scrollOffset, canSwitchProvider: !models.providerScope, providerSwitchDisabledMessage: lockProvider ? `Provider fixed by --provider ${lockProvider}` : undefined, favoriteKeys: models.favoriteKeys, nicknameLabels: models.nicknameLabels, nicknameDraft: models.nicknameDraft })));
}
export default StandaloneModelPickerApp;
//# sourceMappingURL=StandaloneModelPickerApp.js.map