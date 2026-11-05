import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { type ThemeTokens, useTheme } from './theme.js';
import type { MarkdownRenderOptions } from './MarkdownRenderer.js';
interface TableCell {
  text: string;
  tokens: any[];
  header: boolean;
  align: string | null;
}

interface TableToken {
  type: 'table';
  header: TableCell[];
  rows: TableCell[][];
  align: string[];
  raw: string;
}

const TABLE_MAX_WIDTH = 100;
const TABLE_CELL_PADDING = 1;
const TABLE_MIN_COLUMN_WIDTH = 8;
const TABLE_MARGIN_X = 1;
const TABLE_TERMINAL_WRAP_SLACK = 1;

const makeLine = (widths: number[], char: string, joiner: string, left = '', right = ''): string =>
  left + widths.map((w) => char.repeat(w)).join(joiner) + right;

// Cell text flattened to per-character styles, so wrapping and sizing can work
// on the rendered text while each wrapped line keeps its inline formatting.
interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string;
  backgroundColor?: string;
}

interface StyledChar {
  char: string;
  style: CellStyle;
}

interface StyledCell {
  text: string;
  chars: StyledChar[];
}

const flattenInlineTokens = (
  tokens: any[] | undefined,
  style: CellStyle,
  out: StyledChar[],
  theme: ThemeTokens,
): void => {
  const push = (text: string, charStyle: CellStyle) => {
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
        } else {
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
const toStyledCell = (cell: TableCell | undefined, theme: ThemeTokens): StyledCell => {
  const flat: StyledChar[] = [];
  flattenInlineTokens(cell?.tokens, {}, flat, theme);

  const chars: StyledChar[] = [];
  for (const styled of flat) {
    if (/\s/.test(styled.char)) {
      if (chars.length > 0 && chars.at(-1)!.char !== ' ') {
        chars.push({ char: ' ', style: styled.style });
      }
    } else {
      chars.push(styled);
    }
  }
  if (chars.at(-1)?.char === ' ') {
    chars.pop();
  }

  return { text: chars.map((styled) => styled.char).join(''), chars };
};

// Calculate column widths based on content
const calculateColumnWidths = (
  header: StyledCell[],
  rows: StyledCell[][],
  padding = TABLE_CELL_PADDING,
  maxTableWidth = TABLE_MAX_WIDTH,
): number[] => {
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

  const headerMinimumWidths = header.map((cell, index) =>
    Math.min(desiredWidths[index], Math.max(TABLE_MIN_COLUMN_WIDTH, cell.text.length + padding * 2)),
  );
  const minimumTotal = headerMinimumWidths.reduce((sum, width) => sum + width, 0);

  const minimumWidths =
    minimumTotal <= availableWidth
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
const getAlignmentPadding = (padding: number, align: string): [number, number] => {
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

const splitLongWord = (word: string, width: number): string[] => {
  const chunks: string[] = [];

  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }

  return chunks;
};

const wrapCellText = (content: string, width: number): string[] => {
  const normalized = content.replaceAll(/\s+/g, ' ').trim();

  if (!normalized) {
    return [''];
  }

  const words = normalized.split(' ');
  const lines: string[] = [];
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
const getCellStyledLines = (cell: StyledCell | undefined, width: number): StyledChar[][] => {
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

const sameStyle = (a: CellStyle, b: CellStyle): boolean =>
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strikethrough === b.strikethrough &&
  a.color === b.color &&
  a.backgroundColor === b.backgroundColor;

// Render cell content with inline formatting
const renderCellContent = (
  line: StyledChar[],
  width: number,
  align: string,
  isHeader = false,
  options: MarkdownRenderOptions = {},
): React.ReactNode => {
  const contentWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
  const [leftPad, rightPad] = getAlignmentPadding(Math.max(0, contentWidth - line.length), align);

  const runs: Array<{ text: string; style: CellStyle }> = [];
  for (const { char, style } of line) {
    const last = runs.at(-1);
    if (last && sameStyle(last.style, style)) {
      last.text += char;
    } else {
      runs.push({ text: char, style });
    }
  }

  return (
    <Text bold={isHeader} color={options.defaultColor} dimColor={options.dimColor}>
      {' '.repeat(TABLE_CELL_PADDING + leftPad)}
      {runs.map((run, index) => (
        <Text
          key={index}
          bold={run.style.bold || isHeader}
          italic={run.style.italic}
          underline={run.style.underline}
          strikethrough={run.style.strikethrough}
          color={run.style.color ?? options.defaultColor}
          backgroundColor={run.style.backgroundColor}
          dimColor={options.dimColor}
        >
          {run.text}
        </Text>
      ))}
      {' '.repeat(TABLE_CELL_PADDING + rightPad)}
    </Text>
  );
};

// Generate table borders
const generateBorder = (
  widths: number[],
  style: 'ascii' | 'unicode' | 'compact',
): { top: string; middle: string; bottom: string } => {
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

// Table Renderer Component
interface TableRendererProps {
  token: TableToken;
  style?: 'ascii' | 'unicode' | 'compact';
  options?: MarkdownRenderOptions;
  maxWidth?: number;
}

export const TableRenderer = ({ token, style = 'unicode', options = {}, maxWidth }: TableRendererProps) => {
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
  const effectiveMaxWidth = Math.max(
    minimumTableWidth,
    Math.min(TABLE_MAX_WIDTH, containerWidth - TABLE_MARGIN_X * 2 - TABLE_TERMINAL_WRAP_SLACK),
  );

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

  const renderTableRow = (row: StyledCell[], rowKey: string, isHeader = false) => {
    const wrappedCells = columnWidths.map((width, index) => getCellStyledLines(row[index], width));
    const lineCount = Math.max(...wrappedCells.map((lines) => lines.length));

    return Array.from({ length: lineCount }, (_, lineIndex) => (
      <Box key={`${rowKey}-${lineIndex}`} flexDirection="row">
        {vertical.left ? (
          <Text color={theme.textSubtle} dimColor={options.dimColor}>
            {vertical.left}
          </Text>
        ) : null}
        {columnWidths.map((width, index) => {
          const content = wrappedCells[index][lineIndex] ?? [];
          const cell = (
            <Box width={width}>
              {renderCellContent(content, width, columnAlignment[index] || 'left', isHeader, options)}
            </Box>
          );

          return (
            <React.Fragment key={index}>
              {cell}
              {index < numCols - 1 && (
                <Text color={theme.textSubtle} dimColor={options.dimColor}>
                  {vertical.middle}
                </Text>
              )}
            </React.Fragment>
          );
        })}
        {vertical.right ? (
          <Text color={theme.textSubtle} dimColor={options.dimColor}>
            {vertical.right}
          </Text>
        ) : null}
      </Box>
    ));
  };

  // Separator between header and data (only for bordered styles)
  const renderSeparator = () => {
    return (
      <Box marginX={TABLE_MARGIN_X}>
        <Text color={theme.textSubtle} dimColor={options.dimColor}>
          {borders.middle}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box marginX={TABLE_MARGIN_X}>
        <Text color={theme.textSubtle} dimColor={options.dimColor}>
          {borders.top}
        </Text>
      </Box>

      {/* Header */}
      <Box flexDirection="column" marginX={TABLE_MARGIN_X}>
        {renderTableRow(header, 'header', true)}
      </Box>

      {/* Separator */}
      {renderSeparator()}

      {/* Data rows */}
      {rows.map((row, rowIndex) => (
        <React.Fragment key={rowIndex}>
          <Box flexDirection="column" marginX={TABLE_MARGIN_X}>
            {renderTableRow(row, `row-${rowIndex}`)}
          </Box>
          {rowIndex < rows.length - 1 ? renderSeparator() : null}
        </React.Fragment>
      ))}

      {/* Bottom border */}
      <Box marginX={TABLE_MARGIN_X}>
        <Text color={theme.textSubtle} dimColor={options.dimColor}>
          {borders.bottom}
        </Text>
      </Box>
    </Box>
  );
};
