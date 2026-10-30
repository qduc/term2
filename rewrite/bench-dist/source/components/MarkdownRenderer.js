import React, { useMemo } from 'react';
import { Box, Text, Newline, useStdout } from 'ink';
import { marked } from 'marked';
import { useTheme } from './theme.js';
const CODE_FENCE_LANGUAGES = [
    'typescript',
    'javascript',
    'tsx',
    'jsx',
    'python',
    'bash',
    'shell',
    'sh',
    'zsh',
    'json',
    'yaml',
    'yml',
    'html',
    'css',
    'scss',
    'sql',
    'rust',
    'go',
    'java',
    'kotlin',
    'swift',
    'csharp',
    'cs',
    'cpp',
    'c',
    'php',
    'ruby',
    'rb',
    'md',
    'markdown',
].sort((a, b) => b.length - a.length);
const CODE_LINE_START_PATTERN = /^(?:if|for|while|switch|try|catch|else|const|let|var|function|class|interface|type|enum|import|export|return|throw|await|async|def|from|public|private|protected|static|final|package|func|fn|impl|use|echo|cd|npm|npx|yarn|pnpm|sudo|curl|git|<|[{([/@#*$])/;
const normalizeJoinedFenceCodeLines = (markdown) => {
    return markdown.replaceAll(/(^|\n)(`{3,}|~{3,})([^\n]*)/g, (match, linePrefix, fence, info) => {
        if (!info || /^\s/.test(info)) {
            return match;
        }
        for (const language of CODE_FENCE_LANGUAGES) {
            if (!info.startsWith(language) || info.length === language.length) {
                continue;
            }
            const joinedCode = info.slice(language.length);
            if (!CODE_LINE_START_PATTERN.test(joinedCode)) {
                continue;
            }
            return `${linePrefix}${fence}${language}\n${joinedCode}`;
        }
        return match;
    });
};
const TABLE_MAX_WIDTH = 100;
const TABLE_CELL_PADDING = 1;
const TABLE_MIN_COLUMN_WIDTH = 8;
const TABLE_MARGIN_X = 1;
const TABLE_TERMINAL_WRAP_SLACK = 1;
const makeLine = (widths, char, joiner, left = '', right = '') => left + widths.map((w) => char.repeat(w)).join(joiner) + right;
const flattenInlineTokens = (tokens, style, out, theme) => {
    const push = (text, charStyle) => {
        for (const char of text) {
            out.push({ char, style: charStyle });
        }
    };
    for (const token of tokens ?? []) {
        switch (token.type) {
            case 'text':
            case 'escape':
                if (token.tokens) {
                    flattenInlineTokens(token.tokens, style, out, theme);
                }
                else {
                    push(token.text, style);
                }
                break;
            case 'strong':
                flattenInlineTokens(token.tokens, { ...style, bold: true }, out, theme);
                break;
            case 'em':
                flattenInlineTokens(token.tokens, { ...style, italic: true }, out, theme);
                break;
            case 'del':
                flattenInlineTokens(token.tokens, { ...style, strikethrough: true }, out, theme);
                break;
            case 'codespan':
                push(token.text, { ...style, color: theme.warning, backgroundColor: theme.codeBackground });
                break;
            case 'link':
                push(token.text, { ...style, color: theme.accent, underline: true });
                break;
            case 'image':
                push(`[Image: ${token.text}]`, { ...style, color: theme.textSubtle });
                break;
            case 'br':
                push(' ', style);
                break;
            default:
                push(token.raw ?? '', style);
        }
    }
};
// Collapse whitespace runs to one space and trim, mirroring how cell text wraps.
const toStyledCell = (cell, theme) => {
    const flat = [];
    flattenInlineTokens(cell?.tokens, {}, flat, theme);
    const chars = [];
    for (const styled of flat) {
        if (/\s/.test(styled.char)) {
            if (chars.length > 0 && chars.at(-1).char !== ' ') {
                chars.push({ char: ' ', style: styled.style });
            }
        }
        else {
            chars.push(styled);
        }
    }
    if (chars.at(-1)?.char === ' ') {
        chars.pop();
    }
    return { text: chars.map((styled) => styled.char).join(''), chars };
};
// Calculate column widths based on content
const calculateColumnWidths = (header, rows, padding = TABLE_CELL_PADDING, maxTableWidth = TABLE_MAX_WIDTH) => {
    const numCols = header.length;
    const widths = new Array(numCols).fill(0);
    // Start with header widths
    header.forEach((cell, index) => {
        widths[index] = Math.max(widths[index], cell.text.length);
    });
    // Check all rows for maximum width
    rows.forEach((row) => {
        row.forEach((cell, index) => {
            if (index < widths.length) {
                widths[index] = Math.max(widths[index], cell.text.length);
            }
        });
    });
    const desiredWidths = widths.map((width) => width + padding * 2);
    const borderWidth = numCols + 1;
    const availableWidth = Math.max(numCols, maxTableWidth - borderWidth);
    if (desiredWidths.reduce((sum, width) => sum + width, 0) <= availableWidth) {
        return desiredWidths;
    }
    const headerMinimumWidths = header.map((cell, index) => Math.min(desiredWidths[index], Math.max(TABLE_MIN_COLUMN_WIDTH, cell.text.length + padding * 2)));
    const minimumTotal = headerMinimumWidths.reduce((sum, width) => sum + width, 0);
    const minimumWidths = minimumTotal <= availableWidth
        ? headerMinimumWidths
        : new Array(numCols).fill(Math.max(1, Math.min(TABLE_MIN_COLUMN_WIDTH, Math.floor(availableWidth / numCols))));
    const cappedWidths = [...minimumWidths];
    let remainingWidth = availableWidth - minimumWidths.reduce((sum, width) => sum + width, 0);
    const flexibleWidths = desiredWidths.map((width, index) => Math.max(0, width - minimumWidths[index]));
    let flexibleTotal = flexibleWidths.reduce((sum, width) => sum + width, 0);
    while (remainingWidth > 0 && flexibleTotal > 0) {
        let distributed = 0;
        flexibleWidths.forEach((flex, index) => {
            if (remainingWidth <= 0 || flex <= 0) {
                return;
            }
            const share = Math.max(1, Math.floor((remainingWidth * flex) / flexibleTotal));
            const amount = Math.min(share, flex, remainingWidth);
            cappedWidths[index] += amount;
            flexibleWidths[index] -= amount;
            remainingWidth -= amount;
            distributed += amount;
        });
        if (distributed === 0) {
            break;
        }
        flexibleTotal = flexibleWidths.reduce((sum, width) => sum + width, 0);
    }
    return cappedWidths;
};
// Split free space into [left, right] padding based on alignment
const getAlignmentPadding = (padding, align) => {
    switch (align) {
        case 'center': {
            const leftPad = Math.floor(padding / 2);
            return [leftPad, padding - leftPad];
        }
        case 'right':
            return [padding, 0];
        case 'left':
        default:
            return [0, padding];
    }
};
const splitLongWord = (word, width) => {
    const chunks = [];
    for (let index = 0; index < word.length; index += width) {
        chunks.push(word.slice(index, index + width));
    }
    return chunks;
};
const wrapCellText = (content, width) => {
    const normalized = content.replaceAll(/\s+/g, ' ').trim();
    if (!normalized) {
        return [''];
    }
    const words = normalized.split(' ');
    const lines = [];
    let currentLine = '';
    words.forEach((word) => {
        const chunks = word.length > width ? splitLongWord(word, width) : [word];
        chunks.forEach((chunk) => {
            if (!currentLine) {
                currentLine = chunk;
                return;
            }
            if (currentLine.length + 1 + chunk.length <= width) {
                currentLine += ` ${chunk}`;
                return;
            }
            lines.push(currentLine);
            currentLine = chunk;
        });
    });
    if (currentLine) {
        lines.push(currentLine);
    }
    return lines;
};
// Wrap on the plain text, then map each line back onto the styled characters.
// Normalized text has single spaces and lines never start with one, so each
// line is the next slice after skipping at most one break space.
const getCellStyledLines = (cell, width) => {
    const contentWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
    if (!cell) {
        return [[]];
    }
    let cursor = 0;
    return wrapCellText(cell.text, contentWidth).map((line) => {
        if (cell.text[cursor] === ' ') {
            cursor += 1;
        }
        const slice = cell.chars.slice(cursor, cursor + line.length);
        cursor += line.length;
        return slice;
    });
};
const sameStyle = (a, b) => a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor;
// Render cell content with inline formatting
const renderCellContent = (line, width, align, isHeader = false, options = {}) => {
    const contentWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
    const [leftPad, rightPad] = getAlignmentPadding(Math.max(0, contentWidth - line.length), align);
    const runs = [];
    for (const { char, style } of line) {
        const last = runs.at(-1);
        if (last && sameStyle(last.style, style)) {
            last.text += char;
        }
        else {
            runs.push({ text: char, style });
        }
    }
    return (React.createElement(Text, { bold: isHeader, color: options.defaultColor, dimColor: options.dimColor },
        ' '.repeat(TABLE_CELL_PADDING + leftPad),
        runs.map((run, index) => (React.createElement(Text, { key: index, bold: run.style.bold || isHeader, italic: run.style.italic, underline: run.style.underline, strikethrough: run.style.strikethrough, color: run.style.color ?? options.defaultColor, backgroundColor: run.style.backgroundColor, dimColor: options.dimColor }, run.text))),
        ' '.repeat(TABLE_CELL_PADDING + rightPad)));
};
// Generate table borders
const generateBorder = (widths, style) => {
    switch (style) {
        case 'unicode':
            return {
                top: makeLine(widths, '─', '┬', '┌', '┐'),
                middle: makeLine(widths, '─', '┼', '├', '┤'),
                bottom: makeLine(widths, '─', '┴', '└', '┘'),
            };
        case 'compact': {
            const separators = makeLine(widths, '─', '┼');
            return {
                top: separators,
                middle: separators,
                bottom: separators,
            };
        }
        case 'ascii':
        default:
            return {
                top: makeLine(widths, '-', '+', '+', '+'),
                middle: makeLine(widths, '-', '+', '+', '+'),
                bottom: makeLine(widths, '-', '+', '+', '+'),
            };
    }
};
const TableRenderer = ({ token, style = 'unicode', options = {}, maxWidth }) => {
    const theme = useTheme();
    const header = token.header.map((cell) => toStyledCell(cell, theme));
    const rows = token.rows.map((row) => row.map((cell) => toStyledCell(cell, theme)));
    const { align } = token;
    const numCols = header.length;
    const { stdout } = useStdout();
    // Respect the real terminal width so the table never wraps.
    // If a maxWidth is provided (e.g. from a parent with padding), use it
    // instead of the raw terminal width.
    const terminalColumns = stdout.columns || TABLE_MAX_WIDTH;
    const containerWidth = maxWidth ?? terminalColumns;
    const minimumTableWidth = numCols * (TABLE_CELL_PADDING * 2 + 1) + numCols + 1;
    const effectiveMaxWidth = Math.max(minimumTableWidth, Math.min(TABLE_MAX_WIDTH, containerWidth - TABLE_MARGIN_X * 2 - TABLE_TERMINAL_WRAP_SLACK));
    // Calculate column widths
    const columnWidths = calculateColumnWidths(header, rows, TABLE_CELL_PADDING, effectiveMaxWidth);
    // Generate borders
    const borders = generateBorder(columnWidths, style);
    // Ensure alignment array matches number of columns
    const columnAlignment = align.length === numCols ? align : new Array(numCols).fill('left');
    // Define vertical borders based on style
    const getVerticalBorder = () => {
        switch (style) {
            case 'unicode':
                return { left: '│', middle: '│', right: '│' };
            case 'compact':
                return { left: '', middle: '│', right: '' };
            case 'ascii':
            default:
                return { left: '|', middle: '|', right: '|' };
        }
    };
    const vertical = getVerticalBorder();
    const renderTableRow = (row, rowKey, isHeader = false) => {
        const wrappedCells = columnWidths.map((width, index) => getCellStyledLines(row[index], width));
        const lineCount = Math.max(...wrappedCells.map((lines) => lines.length));
        return Array.from({ length: lineCount }, (_, lineIndex) => (React.createElement(Box, { key: `${rowKey}-${lineIndex}`, flexDirection: "row" },
            vertical.left ? (React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, vertical.left)) : null,
            columnWidths.map((width, index) => {
                const content = wrappedCells[index][lineIndex] ?? [];
                const cell = (React.createElement(Box, { width: width }, renderCellContent(content, width, columnAlignment[index] || 'left', isHeader, options)));
                return (React.createElement(React.Fragment, { key: index },
                    cell,
                    index < numCols - 1 && (React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, vertical.middle))));
            }),
            vertical.right ? (React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, vertical.right)) : null)));
    };
    // Separator between header and data (only for bordered styles)
    const renderSeparator = () => {
        return (React.createElement(Box, { marginX: TABLE_MARGIN_X },
            React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, borders.middle)));
    };
    return (React.createElement(Box, { flexDirection: "column" },
        React.createElement(Box, { marginX: TABLE_MARGIN_X },
            React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, borders.top)),
        React.createElement(Box, { flexDirection: "column", marginX: TABLE_MARGIN_X }, renderTableRow(header, 'header', true)),
        renderSeparator(),
        rows.map((row, rowIndex) => (React.createElement(React.Fragment, { key: rowIndex },
            React.createElement(Box, { flexDirection: "column", marginX: TABLE_MARGIN_X }, renderTableRow(row, `row-${rowIndex}`)),
            rowIndex < rows.length - 1 ? renderSeparator() : null))),
        React.createElement(Box, { marginX: TABLE_MARGIN_X },
            React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, borders.bottom))));
};
// --- Token Renderers ---
// recursively render inline content (bold, italic, links, etc.)
const InlineContent = ({ tokens, options = {} }) => {
    const theme = useTheme();
    if (!tokens)
        return null;
    return (React.createElement(React.Fragment, null, tokens.map((token, index) => {
        const key = `${token.type}-${index}`;
        switch (token.type) {
            case 'text':
            case 'escape':
                // Handle nested formatting inside text tokens if marked provides them
                if (token.tokens) {
                    return React.createElement(InlineContent, { key: key, tokens: token.tokens, options: options });
                }
                return (React.createElement(Text, { key: key, color: options.defaultColor, dimColor: options.dimColor }, token.text));
            case 'strong':
                return (React.createElement(Text, { key: key, bold: true, color: options.defaultColor, dimColor: options.dimColor },
                    React.createElement(InlineContent, { tokens: token.tokens, options: options })));
            case 'em':
                return (React.createElement(Text, { key: key, italic: true, color: options.defaultColor, dimColor: options.dimColor },
                    React.createElement(InlineContent, { tokens: token.tokens, options: options })));
            case 'codespan':
                return (React.createElement(Text, { key: key, color: theme.warning, backgroundColor: theme.codeBackground, dimColor: options.dimColor }, ` ${token.text} `));
            case 'link':
                return (React.createElement(Text, { key: key, color: theme.accent, underline: true, dimColor: options.dimColor }, token.text));
            case 'image':
                return (React.createElement(Text, { key: key, color: theme.textSubtle, dimColor: options.dimColor },
                    ' ',
                    "[Image: ",
                    token.text,
                    "]",
                    ' '));
            case 'br':
                return React.createElement(Newline, { key: key });
            default:
                return (React.createElement(Text, { key: key, color: options.defaultColor, dimColor: options.dimColor }, token.raw));
        }
    })));
};
// Render Block elements (Headings, Paragraphs, Lists)
const BlockRenderer = ({ token, options = {}, maxWidth, }) => {
    const theme = useTheme();
    switch (token.type) {
        case 'heading': {
            const isMain = token.depth === 1;
            const hasTrailingBlankLine = token.raw && token.raw.endsWith('\n\n');
            return (React.createElement(Box, { flexDirection: "column" },
                React.createElement(Text, { bold: true, underline: isMain, color: isMain ? theme.success : theme.accent, dimColor: options.dimColor },
                    '#'.repeat(token.depth) + ' ',
                    React.createElement(InlineContent, { tokens: token.tokens, options: options })),
                hasTrailingBlankLine && React.createElement(Box, { height: 1 })));
        }
        case 'paragraph':
            return (React.createElement(Box, null,
                React.createElement(Text, { color: options.defaultColor, dimColor: options.dimColor },
                    React.createElement(InlineContent, { tokens: token.tokens, options: options }))));
        case 'list':
            return (React.createElement(Box, { flexDirection: "column" }, token.items.map((item, index) => (React.createElement(BlockRenderer, { key: index, token: item, options: options })))));
        case 'list_item':
            return (React.createElement(Box, { flexDirection: "row" },
                React.createElement(Box, { marginRight: 1 },
                    React.createElement(Text, { color: theme.success, dimColor: options.dimColor }, "\u2022")),
                React.createElement(Box, { flexDirection: "column", flexGrow: 1 }, token.tokens.map((subToken, i) => {
                    // If it's just text inside the list item, marked might wrap it in a generic block
                    if (subToken.type === 'text') {
                        return (React.createElement(Text, { key: i, color: options.defaultColor, dimColor: options.dimColor },
                            React.createElement(InlineContent, { tokens: subToken.tokens, options: options })));
                    }
                    return React.createElement(BlockRenderer, { key: i, token: subToken, options: options });
                }))));
        case 'code':
            if (!token.text || !token.text.trim())
                return null;
            return (React.createElement(Box, { borderStyle: "round", borderColor: theme.textSubtle, paddingX: 1, flexDirection: "column", width: maxWidth },
                React.createElement(Text, { color: theme.warning, dimColor: options.dimColor }, token.text)));
        case 'blockquote':
            return (React.createElement(Box, { paddingLeft: 2, borderStyle: "classic", borderLeft: true, borderRight: false, borderTop: false, borderBottom: false, borderColor: theme.accent, flexDirection: "column" }, token.tokens.map((t, i) => (React.createElement(BlockRenderer, { key: i, token: t, options: options })))));
        case 'space':
            return React.createElement(Box, { height: 1 });
        case 'hr':
            return (React.createElement(Box, null,
                React.createElement(Text, { color: theme.textSubtle, dimColor: options.dimColor }, "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")));
        case 'table': {
            const hasTableTrailingBlankLine = token.raw && token.raw.endsWith('\n\n');
            return (React.createElement(Box, { flexDirection: "column" },
                React.createElement(TableRenderer, { token: token, options: options, maxWidth: maxWidth }),
                hasTableTrailingBlankLine && React.createElement(Box, { height: 1 })));
        }
        default:
            // Fallback for unknown blocks
            // console.log(`Unknown token type: ${token.type}`);
            return null;
    }
};
// Re-renders only when raw token content or render options change.
// During streaming, only the trailing (in-progress) block will ever change, so all
// prior blocks keep their existing React subtrees without reconciliation.
const MemoBlock = React.memo(({ token, options, maxWidth }) => (React.createElement(BlockRenderer, { token: token, options: options, maxWidth: maxWidth })), (prev, next) => {
    if (prev.options !== next.options) {
        return false;
    }
    if (prev.maxWidth !== next.maxWidth) {
        return false;
    }
    if (typeof prev.token.raw !== 'string' || typeof next.token.raw !== 'string') {
        return false;
    }
    return prev.token.raw === next.token.raw;
});
// Generate a stable key for a token based on its type and content
// This prevents unnecessary re-renders when the AST structure changes during streaming
const getTokenKey = (token, index) => {
    // If token has an id property, use it
    if (token.id) {
        return String(token.id);
    }
    // Use type + first 30 chars of raw content for stable identification
    const rawPreview = token.raw ? token.raw.slice(0, 30).replace(/\s+/g, ' ') : '';
    return `${token.type}-${rawPreview}-${index}`;
};
const MarkdownRenderer = ({ children, tokens, defaultColor, dimColor, maxWidth }) => {
    // Allow passing raw text (which we parse) OR pre-parsed tokens
    const ast = useMemo(() => tokens || marked.lexer(normalizeJoinedFenceCodeLines(String(children || ''))), [tokens, children]);
    const options = useMemo(() => ({ defaultColor, dimColor }), [defaultColor, dimColor]);
    return (React.createElement(Box, { flexDirection: "column" }, ast.map((token, index) => (React.createElement(MemoBlock, { key: getTokenKey(token, index), token: token, options: options, maxWidth: maxWidth })))));
};
export default React.memo(MarkdownRenderer);
//# sourceMappingURL=MarkdownRenderer.js.map