import React from 'react';
import { Box, Text } from 'ink';
import { parseCodeContextSearchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const CodeContextSearchRenderer = ({ output, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseCodeContextSearchOutput(output);
    if (!parsed)
        return null;
    const { queryType } = parsed;
    if (queryType === 'related') {
        const { target: _target, relatedFiles } = parsed;
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
            !relatedFiles || relatedFiles.length === 0 ? (React.createElement(ToolSection, { variant: "indent" },
                React.createElement(Text, { color: theme.textSubtle }, "No related files found."))) : (React.createElement(ToolSection, { variant: "indent" }, relatedFiles.map((f, idx) => (React.createElement(Box, { key: idx, flexDirection: "column", marginBottom: 0.5 },
                React.createElement(Text, { color: theme.text }, f.filePath),
                React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                    ' ',
                    "Relations: ",
                    f.relations))))))));
    }
    else {
        const { symbol: _symbol, results } = parsed;
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
            !results || results.length === 0 ? (React.createElement(ToolSection, { variant: "indent" },
                React.createElement(Text, { color: theme.textSubtle }, "No symbol declarations found."))) : (React.createElement(ToolSection, { variant: "indent" }, results.map((res, idx) => (React.createElement(Text, { key: idx },
                React.createElement(Text, { color: theme.text },
                    res.filePath,
                    ":",
                    res.lineNum),
                React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                    ' ',
                    "\u2502",
                    ' '),
                React.createElement(Text, { color: theme.warning },
                    res.kind,
                    " ",
                    res.name),
                res.exported && (React.createElement(Text, { color: theme.textMuted, dimColor: true },
                    ' ',
                    "(exported)")))))))));
    }
};
export default CodeContextSearchRenderer;
//# sourceMappingURL=CodeContextSearchRenderer.js.map