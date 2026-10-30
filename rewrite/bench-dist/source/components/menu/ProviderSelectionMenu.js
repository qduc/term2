import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const ProviderSelectionMenu = ({ phase, selectedIndex, scrollOffset, activeItems, errorMessage, fieldErrors, selectedProviderName, draft, allowCodexSelection = false, presetQuery = '', }) => {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    const getHeader = () => {
        switch (phase) {
            case 'list':
                return 'Your Providers';
            case 'presets':
                return 'Add Provider';
            case 'accounts':
                return `Accounts: ${selectedProviderName ?? 'Provider'}`;
            case 'wizard_type':
                return 'Step 2: Provider Type';
            case 'edit_fields':
                return 'Review & Save Provider';
            case 'confirm_delete':
                return `Delete Provider: ${selectedProviderName}`;
            case 'confirm_discard':
                return 'Discard Changes?';
            case 'wizard_name':
                return 'Step 1: Provider Name';
            case 'wizard_url':
                return 'Step 3: Base URL';
            case 'wizard_key':
                return 'Step 4: API Key';
            default:
                return 'Manage Providers';
        }
    };
    const getFooter = () => {
        let hints;
        switch (phase) {
            case 'list':
                hints = [
                    ['↑↓', 'navigate'],
                    ['⏎', 'edit provider (enable/disable, API key)'],
                    ['Del', 'delete custom provider'],
                    ['Esc', 'close'],
                ];
                break;
            case 'accounts':
                hints = [
                    ['↑↓', 'navigate'],
                    ['⏎', 'use from next session'],
                    ['Del', 'sign out'],
                    ['Esc', 'back'],
                ];
                break;
            case 'confirm_delete':
            case 'confirm_discard':
            case 'wizard_type':
                hints = [
                    ['↑↓', 'navigate'],
                    ['⏎', 'select'],
                    ['Esc', 'back'],
                ];
                break;
            case 'presets':
                hints = [
                    ['type', 'filter presets'],
                    ['↑↓', 'navigate'],
                    ['⏎', 'select'],
                    ['Esc', 'back'],
                ];
                break;
            case 'edit_fields':
                hints = [
                    ['↑↓', 'navigate'],
                    ['⏎', 'modify field / save'],
                    ['Esc', 'cancel'],
                ];
                break;
            case 'wizard_name':
            case 'wizard_url':
            case 'wizard_key':
                hints = [
                    ['type', 'value below'],
                    ['⏎', 'confirm'],
                    ['Esc', 'back'],
                ];
                break;
            default:
                return null;
        }
        return React.createElement(MenuFooter, { hints: hints });
    };
    const getBorderColor = () => {
        if (errorMessage)
            return theme.danger;
        if (phase === 'confirm_delete' || phase === 'confirm_discard')
            return theme.danger;
        return theme.accent;
    };
    // Render a help card for text prompt wizard steps
    const renderTextWizardPrompt = () => {
        let description = '';
        let currentValue = '';
        if (phase === 'wizard_name') {
            description = 'Enter a unique name for this provider. Example: local-llama';
            currentValue = draft?.name || '';
        }
        else if (phase === 'wizard_url') {
            description = 'Enter the Base API URL (e.g. http://localhost:11434/v1).';
            currentValue = draft?.baseUrl || '';
        }
        else if (phase === 'wizard_key') {
            description = draft?.apiKey
                ? 'Enter a replacement API key, or leave empty to keep the current key.'
                : 'Enter the API key for credentials. Leave empty if none required.';
            currentValue = draft?.apiKey ? '********' : '';
        }
        return (React.createElement(MenuFrame, { title: getHeader(), borderColor: getBorderColor(), hasItems: false, footer: getFooter(), footerPlacement: "inside" },
            React.createElement(Box, { marginTop: 1, flexDirection: "column" },
                React.createElement(Text, { color: theme.textSubtle }, description),
                currentValue && (React.createElement(Box, { marginTop: 1 },
                    React.createElement(Text, { color: theme.warning }, "Current draft value: "),
                    React.createElement(Text, { color: theme.text }, currentValue))),
                errorMessage && (React.createElement(Box, { marginTop: 1 },
                    React.createElement(Text, { color: theme.danger },
                        GLYPH_WARNING,
                        " ",
                        errorMessage))))));
    };
    // Text wizard steps are rendered differently
    if (phase === 'wizard_name' || phase === 'wizard_url' || phase === 'wizard_key') {
        return renderTextWizardPrompt();
    }
    const labelColumnWidth = (() => {
        let maxLen = 0;
        for (const it of activeItems) {
            let p = '  ';
            let l = it.label;
            if (it.kind === 'add-provider') {
                p = '+ ';
            }
            else if (it.kind === 'action') {
                p = it.tone === 'destructive' ? '× ' : '  ';
            }
            else if (it.kind === 'field' && it.detail) {
                l = `${it.label}: ${it.detail}`;
            }
            maxLen = Math.max(maxLen, p.length + l.length);
        }
        return maxLen + 2;
    })();
    const selectedItem = activeItems[selectedIndex];
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { marginBottom: 0 },
            React.createElement(Text, { color: theme.accent, bold: true, underline: true }, getHeader())),
        phase === 'presets' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, { color: theme.textSubtle },
                "Connection templates \u00B7 Filter: ",
                presetQuery || '<all>'),
            selectedItem?.kind === 'preset' && React.createElement(Text, { color: theme.textSubtle }, selectedItem.docsUrl))),
        phase === 'confirm_delete' && (React.createElement(Box, { marginTop: 1, marginBottom: 0 },
            React.createElement(Text, { color: theme.danger, bold: true },
                GLYPH_WARNING,
                " WARNING: Are you sure you want to delete this provider? This action cannot be undone."))),
        phase === 'confirm_discard' && (React.createElement(Box, { marginTop: 1, marginBottom: 0 },
            React.createElement(Text, { color: theme.warning, bold: true },
                GLYPH_WARNING,
                " You have unsaved changes. Discard them?"))),
        errorMessage && phase !== 'edit_fields' && (React.createElement(Box, { marginTop: 1, marginBottom: 0 },
            React.createElement(Text, { color: theme.danger },
                GLYPH_WARNING,
                " ",
                errorMessage))),
        React.createElement(MenuContainer, { items: activeItems, selectedIndex: selectedIndex, scrollOffset: scrollOffset, borderColor: getBorderColor(), footer: getFooter(), isInactive: (item) => item.kind === 'provider' && item.id === 'codex' && !allowCodexSelection, renderItem: (item, index, isSelected, isInactive) => {
                let label = item.label;
                let prefix = '  ';
                let suffix = '';
                let color = isSelected ? theme.accent : theme.text;
                let bold = isSelected;
                if (item.kind === 'provider') {
                    const unavailable = item.hasCredentials === false;
                    const disabled = item.isDisabled === true;
                    color = isInactive
                        ? theme.textSubtle
                        : unavailable
                            ? theme.warning
                            : isSelected
                                ? theme.accent
                                : theme.text;
                    if (item.id === 'codex') {
                        suffix = unavailable
                            ? 'Not logged in on this host · Run `term2 --codex-login`'
                            : 'Run `term2 --codex-login` to login to Codex';
                    }
                    else if (item.id === 'grok') {
                        suffix = unavailable ? 'Not logged in · Browser login: `term2 --grok-login`' : '';
                    }
                    else if (unavailable) {
                        suffix = 'API key not configured on this host · Enter to configure';
                    }
                    if (disabled) {
                        color = isSelected ? theme.accent : theme.textSubtle;
                    }
                }
                else if (item.kind === 'add-provider') {
                    prefix = '+ ';
                    color = isSelected ? theme.accent : theme.warning;
                }
                else if (item.kind === 'action') {
                    prefix = item.tone === 'destructive' ? '× ' : '  ';
                    color =
                        item.tone === 'destructive'
                            ? isSelected
                                ? theme.danger
                                : theme.danger
                            : isSelected
                                ? theme.accent
                                : theme.text;
                    bold = isSelected || item.tone === 'destructive';
                }
                else if (item.kind === 'field' || item.kind === 'type') {
                    prefix = '  ';
                    if (item.kind === 'field' && item.detail) {
                        label = `${item.label}: ${item.detail}`;
                    }
                }
                else if (item.kind === 'account') {
                    // "in use" is what this session is authenticating as right now;
                    // "next session" is a selection that has not taken effect yet.
                    prefix = item.isInUse ? '● ' : item.isSelected ? '◉ ' : '  ';
                    color = item.isInUse
                        ? theme.success
                        : item.isSelected
                            ? theme.accent
                            : isSelected
                                ? theme.accent
                                : theme.text;
                    bold = item.isInUse;
                    suffix = item.isInUse
                        ? item.isSelected
                            ? 'in use'
                            : 'in use · reverts next session'
                        : item.isSelected
                            ? 'selected · takes effect next session'
                            : '';
                }
                else if (item.kind === 'note') {
                    prefix = '  ';
                    color = theme.textSubtle;
                }
                const isDestructive = item.kind === 'action' && item.tone === 'destructive';
                if (isDestructive) {
                    color = isSelected ? theme.danger : theme.danger;
                }
                if (phase === 'edit_fields' && item.kind === 'field') {
                    const error = item.fieldKey ? fieldErrors?.[item.fieldKey] : undefined;
                    return (React.createElement(Box, { key: `${index}-${item.kind}-${item.label}`, flexDirection: "column" },
                        React.createElement(Box, { flexDirection: "row" },
                            React.createElement(SelectionMarker, { selected: isSelected }),
                            React.createElement(Box, { width: labelColumnWidth, flexDirection: "row", flexShrink: 0 },
                                React.createElement(Text, { color: color, bold: bold },
                                    prefix,
                                    label)),
                            suffix ? React.createElement(Text, { color: theme.textSubtle }, suffix) : null),
                        error ? (React.createElement(Box, { marginLeft: 4 },
                            React.createElement(Text, { color: theme.danger },
                                GLYPH_WARNING,
                                " ",
                                error))) : null));
                }
                return (React.createElement(Box, { key: `${index}-${item.kind}-${item.label}`, flexDirection: "row" },
                    React.createElement(SelectionMarker, { selected: isSelected }),
                    React.createElement(Box, { width: labelColumnWidth, flexDirection: "row", flexShrink: 0 },
                        React.createElement(Text, { color: color, bold: bold },
                            prefix,
                            label)),
                    suffix ? React.createElement(Text, { color: theme.textSubtle }, suffix) : null));
            } })));
};
export default ProviderSelectionMenu;
//# sourceMappingURL=ProviderSelectionMenu.js.map