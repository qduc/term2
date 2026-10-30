import React from 'react';
import { Box, Text } from 'ink';
import { truncateOutputLines } from './command-message-helpers.js';
import { TOOL_STATUS_GLYPH, useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
/**
 * Renders a `run_code` card as the work it did: one row per tool the script
 * called, then whatever the script returned. Without the rows a script reads as
 * an opaque blob, since its nested calls otherwise appear only as a count on the
 * last line of the result.
 */
const RunCodeRenderer = ({ trace, success, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    return (React.createElement(Box, { flexDirection: "column" },
        renderStandardHeader(),
        trace.rows.length > 0 && (React.createElement(ToolSection, { variant: "indent" }, trace.rows.map((row) => (React.createElement(Text, { key: row.tool, color: theme.textMuted },
            React.createElement(Text, { color: theme.toolStatus[row.status] }, TOOL_STATUS_GLYPH[row.status]),
            " ",
            row.tool,
            row.count > 1 ? React.createElement(Text, { color: theme.textSubtle },
                " \u00D7",
                row.count) : null,
            row.note ? React.createElement(Text, { color: theme.danger },
                " \u2014 ",
                row.note) : null))))),
        trace.body ? (React.createElement(Text, { color: success === false ? theme.danger : theme.toolOutput }, truncateOutputLines(trace.body))) : null));
};
export default RunCodeRenderer;
//# sourceMappingURL=RunCodeRenderer.js.map