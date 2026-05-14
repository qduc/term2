import React, { useMemo } from 'react';
import { Box, Text, Newline, useStdout } from 'ink';
import { marked } from 'marked';

type MarkdownRenderOptions = {
  defaultColor?: string;
  dimColor?: boolean;
};

// --- Table Rendering Utilities ---

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

// Calculate column widths based on content
const calculateColumnWidths = (
  header: TableCell[],
  rows: TableCell[][],
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

// Pad content based on alignment
const padContent = (content: string, width: number, align: string): string => {
  const contentLength = content.length;
  const padding = width - contentLength;

  switch (align) {
    case 'center':
      const leftPad = Math.floor(padding / 2);
      const rightPad = padding - leftPad;
      return ' '.repeat(leftPad) + content + ' '.repeat(rightPad);
    case 'right':
      return ' '.repeat(padding) + content;
    case 'left':
    default:
      return content + ' '.repeat(padding);
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

const getCellTextLines = (cell: TableCell | undefined, width: number): string[] => {
  const contentWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
  return wrapCellText(cell?.text || '', contentWidth);
};

// Render cell content with inline formatting
const renderCellContent = (
  content: string,
  width: number,
  align: string,
  isHeader = false,
  options: MarkdownRenderOptions = {},
): React.ReactNode => {
  const contentWidth = Math.max(1, width - TABLE_CELL_PADDING * 2);
  const paddedContent = padContent(content, contentWidth, align);
  return (
    <Text bold={isHeader} color={options.defaultColor} dimColor={options.dimColor}>
      {' '.repeat(TABLE_CELL_PADDING)}
      {paddedContent}
      {' '.repeat(TABLE_CELL_PADDING)}
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

const TableRenderer = ({ token, style = 'ascii', options = {}, maxWidth }: TableRendererProps) => {
  const { header, rows, align } = token;
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

  const renderTableRow = (row: TableCell[], rowKey: string, isHeader = false) => {
    const wrappedCells = columnWidths.map((width, index) => getCellTextLines(row[index], width));
    const lineCount = Math.max(...wrappedCells.map((lines) => lines.length));

    return Array.from({ length: lineCount }, (_, lineIndex) => (
      <Box key={`${rowKey}-${lineIndex}`} flexDirection="row">
        {vertical.left ? (
          <Text color="#64748b" dimColor={options.dimColor}>
            {vertical.left}
          </Text>
        ) : null}
        {columnWidths.map((width, index) => {
          const content = wrappedCells[index][lineIndex] || '';
          const cell = (
            <Box width={width}>
              {renderCellContent(content, width, columnAlignment[index] || 'left', isHeader, options)}
            </Box>
          );

          return (
            <React.Fragment key={index}>
              {cell}
              {index < numCols - 1 && (
                <Text color="#64748b" dimColor={options.dimColor}>
                  {vertical.middle}
                </Text>
              )}
            </React.Fragment>
          );
        })}
        {vertical.right ? (
          <Text color="#64748b" dimColor={options.dimColor}>
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
        <Text color="#64748b" dimColor={options.dimColor}>
          {borders.middle}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box marginX={TABLE_MARGIN_X}>
        <Text color="#64748b" dimColor={options.dimColor}>
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
        <Text color="#64748b" dimColor={options.dimColor}>
          {borders.bottom}
        </Text>
      </Box>
    </Box>
  );
};

// --- Token Renderers ---

// recursively render inline content (bold, italic, links, etc.)
const InlineContent = ({ tokens, options = {} }: { tokens: any[]; options?: MarkdownRenderOptions }) => {
  if (!tokens) return null;

  return (
    <>
      {tokens.map((token, index) => {
        const key = `${token.type}-${index}`;

        switch (token.type) {
          case 'text':
          case 'escape':
            // Handle nested formatting inside text tokens if marked provides them
            if (token.tokens) {
              return <InlineContent key={key} tokens={token.tokens} options={options} />;
            }
            return (
              <Text key={key} color={options.defaultColor} dimColor={options.dimColor}>
                {token.text}
              </Text>
            );

          case 'strong':
            return (
              <Text key={key} bold color={options.defaultColor} dimColor={options.dimColor}>
                <InlineContent tokens={token.tokens} options={options} />
              </Text>
            );

          case 'em':
            return (
              <Text key={key} italic color={options.defaultColor} dimColor={options.dimColor}>
                <InlineContent tokens={token.tokens} options={options} />
              </Text>
            );

          case 'codespan':
            return (
              <Text key={key} color="yellow" backgroundColor="#333" dimColor={options.dimColor}>
                {`\u00A0${token.text}\u00A0`}
              </Text>
            );

          case 'link':
            return (
              <Text key={key} color="#3b82f6" underline dimColor={options.dimColor}>
                {token.text}
              </Text>
            );

          case 'image':
            return (
              <Text key={key} color="#64748b" dimColor={options.dimColor}>
                {' '}
                [Image: {token.text}]{' '}
              </Text>
            );

          case 'br':
            return <Newline key={key} />;

          default:
            return (
              <Text key={key} color={options.defaultColor} dimColor={options.dimColor}>
                {token.raw}
              </Text>
            );
        }
      })}
    </>
  );
};

// Render Block elements (Headings, Paragraphs, Lists)
const BlockRenderer = ({
  token,
  options = {},
  maxWidth,
}: {
  token: any;
  options?: MarkdownRenderOptions;
  maxWidth?: number;
}) => {
  switch (token.type) {
    case 'heading':
      const isMain = token.depth === 1;
      return (
        <Box flexDirection="column">
          <Text bold underline={isMain} color={isMain ? 'green' : 'cyan'} dimColor={options.dimColor}>
            {isMain ? '# ' : '## '}
            <InlineContent tokens={token.tokens} options={options} />
          </Text>
        </Box>
      );

    case 'paragraph':
      return (
        <Box>
          <Text color={options.defaultColor} dimColor={options.dimColor}>
            <InlineContent tokens={token.tokens} options={options} />
          </Text>
        </Box>
      );

    case 'list':
      return (
        <Box flexDirection="column">
          {token.items.map((item: any, index: number) => (
            <BlockRenderer key={index} token={item} options={options} />
          ))}
        </Box>
      );

    case 'list_item':
      return (
        <Box flexDirection="row">
          <Box marginRight={1}>
            <Text color="green" dimColor={options.dimColor}>
              •
            </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {/* List items can contain multiple block tokens (like sub-lists or paragraphs) */}
            {token.tokens.map((subToken: any, i: number) => {
              // If it's just text inside the list item, marked might wrap it in a generic block
              if (subToken.type === 'text') {
                return (
                  <Text key={i} color={options.defaultColor} dimColor={options.dimColor}>
                    <InlineContent tokens={subToken.tokens} options={options} />
                  </Text>
                );
              }
              return <BlockRenderer key={i} token={subToken} options={options} />;
            })}
          </Box>
        </Box>
      );

    case 'code':
      if (!token.text || !token.text.trim()) return null;
      return (
        <Box borderStyle="round" borderColor="#64748b" paddingX={1} flexDirection="column">
          <Text color="yellow" dimColor={options.dimColor}>
            {token.text}
          </Text>
        </Box>
      );

    case 'blockquote':
      return (
        <Box
          paddingLeft={2}
          borderStyle="classic"
          borderLeft
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          borderColor="magenta"
          flexDirection="column"
        >
          {/* Blockquotes often contain nested paragraphs which render as Boxes */}
          {/* We cannot wrap them in Text because Box in Text causes a crash */}
          {token.tokens.map((t: any, i: number) => (
            <BlockRenderer key={i} token={t} options={options} />
          ))}
        </Box>
      );

    case 'space':
      return null;

    case 'hr':
      return (
        <Box>
          <Text color="#64748b" dimColor={options.dimColor}>
            ────────────────────────────────────────
          </Text>
        </Box>
      );

    case 'table':
      return <TableRenderer token={token} options={options} maxWidth={maxWidth} />;

    default:
      // Fallback for unknown blocks
      // console.log(`Unknown token type: ${token.type}`);
      return null;
  }
};

// Re-renders only when raw token content or render options change.
// During streaming, only the trailing (in-progress) block will ever change, so all
// prior blocks keep their existing React subtrees without reconciliation.
const MemoBlock = React.memo(
  ({ token, options, maxWidth }: { token: any; options: MarkdownRenderOptions; maxWidth?: number }) => (
    <BlockRenderer token={token} options={options} maxWidth={maxWidth} />
  ),
  (prev, next) => {
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
  },
);

// --- Main Component ---

interface MarkdownRendererProps {
  children?: React.ReactNode;
  tokens?: any[];
  defaultColor?: string;
  dimColor?: boolean;
  maxWidth?: number;
}

// Generate a stable key for a token based on its type and content
// This prevents unnecessary re-renders when the AST structure changes during streaming
const getTokenKey = (token: any, index: number): string => {
  // If token has an id property, use it
  if (token.id) {
    return String(token.id);
  }
  // Use type + first 30 chars of raw content for stable identification
  const rawPreview = token.raw ? token.raw.slice(0, 30).replace(/\s+/g, ' ') : '';
  return `${token.type}-${rawPreview}-${index}`;
};

const MarkdownRenderer = ({ children, tokens, defaultColor, dimColor, maxWidth }: MarkdownRendererProps) => {
  // Allow passing raw text (which we parse) OR pre-parsed tokens
  const ast = useMemo(() => tokens || marked.lexer(String(children || '')), [tokens, children]);
  const options = useMemo(() => ({ defaultColor, dimColor }), [defaultColor, dimColor]);

  return (
    <Box flexDirection="column">
      {ast.map((token: any, index: number) => (
        <MemoBlock key={getTokenKey(token, index)} token={token} options={options} maxWidth={maxWidth} />
      ))}
    </Box>
  );
};

export default React.memo(MarkdownRenderer);
