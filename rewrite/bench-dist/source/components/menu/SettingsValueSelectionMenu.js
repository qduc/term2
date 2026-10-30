import React from 'react';
import { Box, Text } from 'ink';
import { isSecretSetting, isStringSetting } from '../../utils/value-suggestions.js';
import { formatSettingDisplayValue } from './settings-value-formatter.js';
import { getSettingLabel, isBooleanSetting, isDurationSetting } from '../../services/settings/settings-ui-metadata.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';
const SettingsValueSelectionMenu = ({ settingKey, items, selectedIndex, query, isNumericSettings, currentText, defaultText, previewText, unitHint, overrideNote, }) => {
    const theme = useTheme();
    const acceptsAnyString = isStringSetting(settingKey);
    // Strings and numbers are settable by typing, so an empty list is a
    // neutral state. Choices (enums, booleans) stay red: Enter cannot apply
    // text their schema does not accept.
    const acceptsTypedValue = acceptsAnyString || Boolean(isNumericSettings);
    const showNeutralEmpty = items.length === 0 && acceptsTypedValue;
    const selectedItem = items[selectedIndex];
    const title = getSettingLabel(settingKey);
    const isSecret = isSecretSetting(settingKey);
    const displayOption = (value) => {
        if (isSecret)
            return '•'.repeat(value.length);
        if (isDurationSetting(settingKey))
            return formatSettingDisplayValue(settingKey, Number(value)).text;
        if (isBooleanSetting(settingKey) && (value === 'true' || value === 'false'))
            return value === 'true' ? 'ON' : 'OFF';
        return value;
    };
    const canCopySuggestion = items.length > 0 && !isSecretSetting(settingKey);
    const header = (currentText !== undefined || defaultText !== undefined || unitHint || overrideNote) && (React.createElement(Box, { flexDirection: "column", marginBottom: 1 },
        React.createElement(Text, { color: theme.textSubtle },
            currentText !== undefined && (React.createElement(React.Fragment, null,
                "Current: ",
                React.createElement(Text, { color: theme.text }, currentText))),
            currentText !== undefined && defaultText !== undefined && ' · ',
            defaultText !== undefined && !(settingKey === 'agent.reasoningEffort' && defaultText === 'default') && (React.createElement(React.Fragment, null,
                "Default: ",
                React.createElement(Text, { color: theme.text }, defaultText)))),
        unitHint && React.createElement(Text, { color: theme.textSubtle }, unitHint),
        overrideNote && React.createElement(Text, { color: theme.warning }, overrideNote)));
    const typedHint = query ? 'Enter saves what you typed' : 'Type a value, then press Enter';
    return (React.createElement(Box, { flexDirection: "column" },
        header,
        React.createElement(MenuContainer, { items: items, selectedIndex: selectedIndex, borderColor: items.length === 0 && !showNeutralEmpty ? theme.danger : theme.accent, title: title, fallbackText: showNeutralEmpty ? (React.createElement(Box, { flexDirection: "column" },
                React.createElement(Text, { color: theme.textSubtle }, isNumericSettings ? 'Type a number' : 'Type a value'),
                React.createElement(Text, { color: theme.textSubtle }, query ? `No suggestion matches — ${typedHint}` : typedHint))) : (React.createElement(Box, { flexDirection: "column" },
                React.createElement(Text, { color: theme.danger, bold: true },
                    "No option matches \"",
                    query,
                    "\""),
                React.createElement(Text, { color: theme.textSubtle }, "Backspace to see all options"))), footer: React.createElement(Box, { flexDirection: "column" }, selectedItem?.description && (React.createElement(Box, { marginBottom: 0 },
                React.createElement(Text, { color: theme.accent, italic: true }, selectedItem.description)))), footerOutsideBorder: false, renderItem: (item, _index, isSelected) => (React.createElement(Box, { key: item.value },
                React.createElement(SelectionMarker, { selected: isSelected }),
                React.createElement(Text, { color: isSelected ? theme.accent : theme.text, bold: isSelected }, displayOption(item.value)))) }),
        previewText !== undefined && (React.createElement(Text, { color: theme.textSubtle },
            "Enter will set: ",
            React.createElement(Text, { color: theme.success }, previewText))),
        React.createElement(MenuFooter, { hints: [
                ...(items.length > 0 ? [['↑↓', 'choose']] : []),
                ['⏎', 'apply'],
                ...(canCopySuggestion ? [['Tab', 'use value']] : []),
                ['Ctrl+D', `reset ${defaultText !== undefined ? `to ${defaultText}` : 'to default'}`],
                ['Esc', 'back'],
            ] })));
};
export default SettingsValueSelectionMenu;
//# sourceMappingURL=SettingsValueSelectionMenu.js.map