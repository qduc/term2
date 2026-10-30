import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import SettingsValueSelectionMenu from '../menu/SettingsValueSelectionMenu.js';
import { parseSettingValueForKey } from '../../utils/settings-command.js';
import { isSecretSetting } from '../../utils/value-suggestions.js';
import { getSettingMetadata, isDurationSetting, isUsdMicrosSetting, } from '../../services/settings/settings-ui-metadata.js';
import { formatSettingValueDetail } from '../menu/settings-value-formatter.js';
import { SETTING_ENV_VARIABLES } from '../../services/settings/settings-env.js';
import { applyMenuEditorEvent } from './menu-editor.js';
import { useTheme } from '../theme.js';
export function SettingsValueMenuSession({ frame, active, controller, interactions, services }) {
    const theme = useTheme();
    const settingsValue = services.settingsValue;
    const settingsService = services.settingsService;
    const [applyError, setApplyError] = useState(null);
    // Enums and booleans only accept their listed options; typed text that
    // matches none of them has nothing valid to apply.
    const settingType = getSettingMetadata(frame.settingKey)?.type;
    const isChoice = settingType === 'enum' || settingType === 'boolean';
    const resolveTypedOrSelectedValue = useCallback(() => {
        const suggestion = settingsValue.getSelectedItem();
        // A free-form string frame is a field, not a picker: Enter applies the
        // whole value text from the value-region start. binding.query is
        // truncated at the cursor, so Home/End (or left/right) cursor moves
        // would otherwise silently drop the tail of what was typed. A blank
        // draft returns undefined and the accept branch reports it inline.
        if (settingsValue.isFreeFormString) {
            const editor = controller.getSnapshot().editor;
            const draft = editor.text.slice(frame.binding.replacement.start).trim();
            return draft ? parseSettingValueForKey(frame.settingKey, draft) : undefined;
        }
        // The editor shows and suggests dollars, so a bare number typed here means
        // dollars too ("5" is $5, not 5 micros). The `/settings <key> <value>`
        // command keeps the stored unit its key name states.
        const typedValueText = isUsdMicrosSetting(frame.settingKey) && /^\d+(?:\.\d+)?$/.test(frame.binding.query.trim())
            ? `$${frame.binding.query.trim()}`
            : frame.binding.query;
        const parsedTypedValue = typedValueText ? parseSettingValueForKey(frame.settingKey, typedValueText) : undefined;
        const parsedSuggestionValue = suggestion ? parseSettingValueForKey(frame.settingKey, suggestion.value) : undefined;
        const shouldPreferTypedNumericValue = settingsValue.isNumericSettings &&
            parsedTypedValue !== undefined &&
            String(parsedTypedValue) !== suggestion?.value;
        return shouldPreferTypedNumericValue ? parsedTypedValue : parsedSuggestionValue ?? parsedTypedValue;
    }, [controller, frame, settingsValue]);
    const interaction = useMemo(() => {
        const keep = () => ({ stack: { type: 'keep' } });
        return {
            handle: (event) => {
                if (!('type' in event)) {
                    // Correlated IntentResult for the apply-settings/reset-setting
                    // intent this frame issued. Success closes through the declared
                    // BackPolicy; failure reports a field error without reopening or
                    // reconstructing the frame.
                    if (event.ok) {
                        return { stack: { type: 'close-top' } };
                    }
                    setApplyError(event.fieldErrors?.[frame.settingKey] ?? event.message);
                    return keep();
                }
                if (applyMenuEditorEvent(controller, event))
                    return keep();
                switch (event.type) {
                    case 'move':
                        setApplyError(null);
                        // Text grammar for field frames: Home/End move the editor cursor
                        // inside the value, not list selection (there is no list to move
                        // in). Accept reads the full value text, so nothing is lost.
                        if (settingsValue.isFreeFormString && (event.direction === 'home' || event.direction === 'end')) {
                            const editor = controller.getSnapshot().editor;
                            const target = event.direction === 'home' ? frame.binding.replacement.start : editor.text.length;
                            controller.applyEditorEdit({ type: 'move-cursor', cursor: target });
                            return keep();
                        }
                        if (event.direction === 'up')
                            settingsValue.moveUp();
                        else if (event.direction === 'down')
                            settingsValue.moveDown();
                        else if (event.direction === 'home')
                            settingsValue.moveHome();
                        else if (event.direction === 'end')
                            settingsValue.moveEnd();
                        else if (event.direction === 'page-up')
                            settingsValue.pageUp();
                        else
                            settingsValue.pageDown();
                        return keep();
                    case 'command': {
                        setApplyError(null);
                        if (event.command === 'tab') {
                            // Tab is inert for secrets: completing one would write the stored
                            // credential into the buffer, so a following paste would append
                            // to it rather than replace it.
                            if (isSecretSetting(frame.settingKey))
                                return keep();
                            const suggestion = settingsValue.getSelectedItem();
                            if (!suggestion)
                                return keep();
                            const currentEditor = controller.getSnapshot().editor;
                            const nextText = currentEditor.text.slice(0, frame.binding.replacement.start) + suggestion.value;
                            return { buffer: { type: 'replace', text: nextText, cursor: nextText.length }, stack: { type: 'keep' } };
                        }
                        if (event.command === 'reset') {
                            return {
                                stack: { type: 'keep' },
                                intent: {
                                    id: `reset-setting:${frame.id}`,
                                    sourceFrameId: frame.id,
                                    intent: { type: 'reset-setting', key: frame.settingKey },
                                },
                            };
                        }
                        return keep();
                    }
                    case 'accept': {
                        setApplyError(null);
                        if (isChoice && !settingsValue.getSelectedItem()) {
                            setApplyError(frame.binding.query
                                ? `"${frame.binding.query}" is not one of the options`
                                : 'Pick one of the options before applying');
                            return keep();
                        }
                        const parsedValue = resolveTypedOrSelectedValue();
                        if (parsedValue === undefined) {
                            // An empty draft has nothing to apply. Keep the frame open and
                            // report instead of closing, which looked like a successful save.
                            setApplyError('Type a value before applying');
                            return keep();
                        }
                        const persistence = settingsService.isRuntimeModifiable(frame.settingKey) ? 'runtime' : 'restart';
                        return {
                            stack: { type: 'keep' },
                            intent: {
                                id: `apply-settings:${frame.id}`,
                                sourceFrameId: frame.id,
                                intent: {
                                    type: 'apply-settings',
                                    changes: [{ key: frame.settingKey, value: parsedValue, persistence }],
                                },
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
    }, [controller, frame, isChoice, resolveTypedOrSelectedValue, settingsService, settingsValue]);
    useEffect(() => {
        if (!active)
            return;
        return interactions.register(frame.id, interaction);
    }, [active, frame.id, interaction, interactions]);
    if (!active)
        return null;
    const draftValue = isChoice && !settingsValue.getSelectedItem() ? undefined : resolveTypedOrSelectedValue();
    const currentValue = readSetting(() => settingsService.getDynamic(frame.settingKey));
    const defaultValue = readSetting(() => settingsService.getDefault(frame.settingKey));
    const unitHint = isDurationSetting(frame.settingKey)
        ? 'Also accepts 30s, 5m, 1h 30m (plain numbers are milliseconds)'
        : isUsdMicrosSetting(frame.settingKey)
            ? 'Amount in dollars, e.g. 5 or 0.25'
            : undefined;
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(SettingsValueSelectionMenu, { settingKey: frame.settingKey, items: settingsValue.filteredEntries, selectedIndex: settingsValue.selectedIndex, query: frame.binding.query, isNumericSettings: settingsValue.isNumericSettings, currentText: currentValue.ok ? formatSettingValueDetail(frame.settingKey, currentValue.value) : undefined, defaultText: defaultValue.ok ? formatSettingValueDetail(frame.settingKey, defaultValue.value) : undefined, previewText: draftValue === undefined ? undefined : formatSettingValueDetail(frame.settingKey, draftValue), unitHint: unitHint, overrideNote: describeStartupOverride(settingsService, frame.settingKey) }),
        applyError && React.createElement(Text, { color: theme.danger }, applyError)));
}
/** Saving here does not stick if an env var or CLI flag sets the key at launch. */
function describeStartupOverride(settingsService, key) {
    const source = readSetting(() => settingsService.getStartupOverride(key));
    if (!source.ok || !source.value)
        return undefined;
    const name = SETTING_ENV_VARIABLES[key];
    const who = source.value === 'env' ? (name ? `$${name}` : 'An environment variable') : 'A command-line flag';
    return `${who} sets this at startup, so it will override a saved value next launch.`;
}
function readSetting(read) {
    try {
        return { ok: true, value: read() };
    }
    catch {
        return { ok: false };
    }
}
//# sourceMappingURL=SettingsValueMenuSession.js.map