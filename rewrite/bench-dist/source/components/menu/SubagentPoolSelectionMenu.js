import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter } from '../common/MenuContainer.js';
import { GLYPH_WARNING, GLYPH_SELECTED, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
import { formatSubagentPoolProvider, formatSubagentPoolReasoning, } from '../../hooks/use-subagent-pool-selection.js';
function SubagentPoolSelectionMenu({ phase, selectedIndex, activeItems, draft, errorMessage, fieldErrors, roleLabel, poolKind, entryShape, }) {
    const theme = useTheme();
    const { MenuFrame } = useSkin();
    const title = phase === 'list'
        ? `${roleLabel} Pool`
        : phase === 'edit_fields'
            ? draft?._isNew
                ? `Add ${roleLabel} Entry`
                : `Edit ${roleLabel} Entry`
            : phase === 'edit_model'
                ? 'Enter Model ID'
                : phase === 'edit_provider'
                    ? 'Select Provider'
                    : phase === 'edit_reasoning'
                        ? 'Select Reasoning Effort'
                        : phase === 'confirm_delete'
                            ? `Delete ${roleLabel} Entry?`
                            : 'Discard Changes?';
    if (phase === 'edit_model') {
        return (React.createElement(MenuFrame, { title: title, borderColor: errorMessage ? theme.danger : theme.accent, hasItems: false, footerPlacement: "outside" },
            React.createElement(Text, { color: theme.textSubtle }, "Type the model ID below and press Enter."),
            React.createElement(Text, { color: theme.warning },
                "Current value: ",
                draft?.model || '<empty>'),
            errorMessage && (React.createElement(Text, { color: theme.danger },
                GLYPH_WARNING,
                " ",
                errorMessage)),
            React.createElement(MenuFooter, { hints: [['Esc', 'back']] })));
    }
    const footer = (React.createElement(MenuFooter, { hints: phase === 'list'
            ? [
                ['↑↓', 'navigate'],
                ['⏎', 'select'],
                ['Del', 'delete'],
                ['Esc', 'save & close'],
            ]
            : phase === 'edit_fields'
                ? [
                    ['↑↓', 'navigate'],
                    ['⏎', 'edit field / save'],
                    ['Esc', 'cancel'],
                ]
                : [
                    ['↑↓', 'navigate'],
                    ['⏎', 'select'],
                    ['Esc', 'back'],
                ] }));
    const entryCount = activeItems.filter((item) => item.kind === 'entry').length;
    const isListEmpty = phase === 'list' && entryCount === 0;
    const listSummary = poolKind === 'fanout'
        ? 'Each entry gets one independent answer for each question.'
        : entryShape === 'models'
            ? 'Subagent spawns use the next entry, round-robin; other tasks use the first entry.'
            : 'Each spawn uses the next entry, round-robin.';
    const listCountSuffix = poolKind === 'fanout'
        ? 'A configured pool overrides mentor samples.'
        : entryShape === 'models'
            ? 'A configured pool overrides the tier fallback.'
            : 'A configured pool overrides the role model.';
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Text, { color: phase === 'confirm_delete' ? theme.danger : theme.accent, bold: true, underline: true }, title),
        phase === 'list' && (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Text, { color: theme.textSubtle }, listSummary),
            React.createElement(Text, { color: theme.textSubtle },
                entryCount,
                "/8 entries \u00B7 ",
                listCountSuffix),
            isListEmpty && (React.createElement(Text, { color: theme.textSubtle },
                "No ",
                roleLabel.toLowerCase(),
                " entries configured yet. Add one to get started.")))),
        phase === 'confirm_delete' && (React.createElement(Text, { color: theme.danger },
            GLYPH_WARNING,
            " This entry will be removed from the pool.")),
        phase === 'confirm_discard' && (React.createElement(Text, { color: theme.warning },
            GLYPH_WARNING,
            " You have unsaved changes. Discard them?")),
        errorMessage && (React.createElement(Text, { color: theme.danger },
            GLYPH_WARNING,
            " ",
            errorMessage)),
        React.createElement(MenuContainer, { items: activeItems, selectedIndex: selectedIndex, borderColor: phase === 'confirm_delete' || phase === 'confirm_discard' || errorMessage ? theme.danger : theme.accent, footer: footer, renderItem: (item, index, selected, inactive) => {
                let label = item.label;
                let prefix = selected ? `${GLYPH_SELECTED} ` : '  ';
                let color = selected ? theme.accent : theme.text;
                if (item.kind === 'action') {
                    prefix = item.action === 'add' ? '+ ' : item.action === 'save' ? '✓ ' : prefix;
                    color =
                        item.tone === 'destructive'
                            ? theme.danger
                            : item.action === 'add'
                                ? theme.warning
                                : selected
                                    ? theme.accent
                                    : theme.text;
                }
                else if (item.kind === 'field') {
                    label = `${item.label}: ${item.detail}`;
                    color = selected ? theme.accent : theme.text;
                }
                else if (item.kind === 'entry') {
                    label = `${item.index + 1}. ${item.entry.model}`;
                }
                else if (item.kind === 'provider' || item.kind === 'reasoning') {
                    color = selected ? theme.accent : theme.text;
                }
                if (inactive)
                    color = theme.textSubtle;
                const field = item.kind === 'field' ? fieldErrors[item.field] : undefined;
                return (React.createElement(Box, { key: `${item.kind}-${index}-${label}`, flexDirection: "column" },
                    React.createElement(Box, { flexDirection: "row" },
                        React.createElement(Text, { color: color, bold: selected || (item.kind === 'action' && item.tone === 'destructive') },
                            prefix,
                            label),
                        item.kind === 'entry' && entryShape === 'entries' ? (React.createElement(Text, { color: selected ? theme.text : theme.textSubtle },
                            '  ',
                            "\u00B7 Provider: ",
                            formatSubagentPoolProvider(item.entry.provider, roleLabel),
                            " \u00B7 Reasoning:",
                            ' ',
                            formatSubagentPoolReasoning(item.entry.reasoningEffort, roleLabel))) : null),
                    field && (React.createElement(Text, { color: theme.danger },
                        ' ',
                        GLYPH_WARNING,
                        " ",
                        field))));
            } })));
}
export default SubagentPoolSelectionMenu;
//# sourceMappingURL=SubagentPoolSelectionMenu.js.map