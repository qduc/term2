import React from 'react';
import { Box, Text } from 'ink';
import { parseMemoryOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text);
const MemoryRenderer = ({ output, toolName, query, renderStandardHeader }) => {
    const theme = useTheme();
    const { ToolSection } = useSkin();
    const parsed = parseMemoryOutput(output);
    if (!parsed)
        return null;
    if (parsed.type === 'error') {
        return (React.createElement(Box, { flexDirection: "column" },
            renderStandardHeader(),
            React.createElement(ToolSection, { variant: "indent" },
                React.createElement(Text, { color: theme.danger },
                    parsed.code ? `[${parsed.code}] ` : '',
                    parsed.message))));
    }
    if (parsed.type === 'list') {
        const sections = parsed.scope === 'all' ? { Global: parsed.global || [], Project: parsed.project || [] } : null;
        const groups = sections ? Object.entries(sections) : [['All', parsed.memories || []]];
        const total = groups.reduce((sum, [, list]) => sum + list.length, 0);
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
            React.createElement(ToolSection, { variant: "indent" },
                React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                    total,
                    " memor",
                    total === 1 ? 'y' : 'ies',
                    " found",
                    parsed.omitted ? `; ${parsed.omitted} omitted` : '',
                    parsed.unavailable ? `; ${parsed.unavailable} unavailable` : ''),
                groups.map(([label, memories]) => (React.createElement(Box, { key: label, flexDirection: "column" },
                    React.createElement(Text, { color: theme.accent, bold: true }, label),
                    memories.length === 0 ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true }, "none")) : (memories.map((m, idx) => (React.createElement(Box, { key: idx, flexDirection: "column", marginTop: 1 },
                        React.createElement(Text, { color: theme.accent, bold: true }, m.title || m.id),
                        m.summary ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true }, truncate(m.summary, 140))) : null,
                        m.tags && m.tags.length > 0 ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                            "tags: ",
                            m.tags.join(', '))) : null,
                        m.scope ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                            "scope: ",
                            m.scope)) : null))))))))));
    }
    if (parsed.type === 'get') {
        const m = parsed.memory;
        if (toolName === 'memory_create') {
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                    React.createElement(ToolSection, { variant: "indent" },
                        React.createElement(Text, { color: theme.toolOutput, dimColor: true },
                            "Saved memory ",
                            m?.id ? `"${m.id}"` : '',
                            m?.title ? ` - "${m.title}"` : '')))));
        }
        if (toolName === 'memory_update') {
            return (React.createElement(Box, { flexDirection: "column" },
                renderStandardHeader(),
                React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                    React.createElement(ToolSection, { variant: "indent" },
                        React.createElement(Text, { color: theme.toolOutput, dimColor: true },
                            "Updated memory ",
                            m?.id ? `"${m.id}"` : '',
                            m?.title ? ` - "${m.title}"` : '')))));
        }
        return (React.createElement(Box, { flexDirection: "column" },
            renderStandardHeader(),
            React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                React.createElement(ToolSection, { variant: "panel" },
                    React.createElement(Text, { color: theme.text, bold: true }, m.title || m.id),
                    m.summary ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true }, m.summary)) : null,
                    m.tags && m.tags.length > 0 ? (React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                        "tags: ",
                        m.tags.join(', '))) : null,
                    m.content ? (React.createElement(Box, { marginTop: 1 },
                        React.createElement(Text, { color: theme.toolOutput }, m.content))) : null))));
    }
    if (parsed.type === 'search') {
        const { results } = parsed;
        return (React.createElement(Box, { flexDirection: "column" },
            React.createElement(Box, { marginBottom: 1 }, renderStandardHeader()),
            React.createElement(ToolSection, { variant: "indent" },
                React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                    results.length,
                    " result",
                    results.length === 1 ? '' : 's',
                    query ? ` for "${query}"` : '',
                    parsed.omitted ? `; ${parsed.omitted} omitted` : '')),
            React.createElement(ToolSection, { variant: "indent" }, results.map((r, idx) => (React.createElement(Box, { key: idx, flexDirection: "column", marginTop: 1 },
                React.createElement(Text, { color: theme.accent, bold: true }, r.memory?.title || r.memory?.id),
                React.createElement(Text, { color: theme.textSubtle, dimColor: true },
                    "[",
                    r.scope || 'all',
                    "] matched: ",
                    (r.matchedFields || []).join(', ') || 'n/a'),
                r.memory?.summary ? React.createElement(Text, { color: theme.toolOutput }, truncate(r.memory.summary, 140)) : null,
                r.contentSnippet?.text ? React.createElement(Text, { color: theme.toolOutput }, r.contentSnippet.text) : null))))));
    }
    if (parsed.type === 'delete') {
        return (React.createElement(Box, { flexDirection: "column" },
            renderStandardHeader(),
            React.createElement(Box, { flexDirection: "column", marginTop: 1 },
                React.createElement(ToolSection, { variant: "indent" },
                    React.createElement(Text, { color: theme.toolOutput, dimColor: true }, parsed.deleted ? 'Deleted' : 'Memory not found')))));
    }
    return null;
};
export default MemoryRenderer;
//# sourceMappingURL=MemoryRenderer.js.map