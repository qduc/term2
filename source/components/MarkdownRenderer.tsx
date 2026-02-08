import React, { useMemo } from 'react';
import { Box, Text, Newline } from 'ink';
import { marked } from 'marked';

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

// Calculate column widths based on content
const calculateColumnWidths = (header: TableCell[], rows: TableCell[][], padding = 2): number[] => {
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

  // Add padding
  return widths.map((width) => width + padding * 2);
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

// Render cell content with inline formatting
const renderCellContent = (cell: TableCell, width: number, align: string): React.ReactNode => {
  const paddedContent = padContent(cell.text, width, align);
  return <Text key={cell.text}>{paddedContent}</Text>;
};

// Generate table borders
const generateBorder = (
  widths: number[],
  style: 'ascii' | 'unicode' | 'compact',
): { top: string; middle: string; bottom: string } => {
  switch (style) {
    case 'unicode':
      const unicodeTop = '┌' + widths.map((w) => '─'.repeat(w)).join('┬') + '┐';
      const unicodeMiddle = '├' + widths.map((w) => '─'.repeat(w)).join('┼') + '┤';
      const unicodeBottom = '└' + widths.map((w) => '─'.repeat(w)).join('┴') + '┘';
      return {
        top: unicodeTop,
        middle: unicodeMiddle,
        bottom: unicodeBottom,
      };

    case 'compact':
      // Just separators without borders
      const separators = widths.map((w) => '─'.repeat(w)).join('┼');
      return {
        top: separators,
        middle: separators,
        bottom: separators,
      };

    case 'ascii':
    default:
      const asciiTop = '+' + widths.map((w) => '-'.repeat(w)).join('+') + '+';
      const asciiMiddle = '+' + widths.map((w) => '-'.repeat(w)).join('+') + '+';
      const asciiBottom = '+' + widths.map((w) => '-'.repeat(w)).join('+') + '+';
      return { top: asciiTop, middle: asciiMiddle, bottom: asciiBottom };
  }
};

// Table Renderer Component
interface TableRendererProps {
  token: TableToken;
  style?: 'ascii' | 'unicode' | 'compact';
}

const TableRenderer = ({ token, style = 'ascii' }: TableRendererProps) => {
  const { header, rows, align } = token;
  const numCols = header.length;

  // Calculate column widths
  const columnWidths = calculateColumnWidths(header, rows);

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

  // Render header row
  const renderHeaderRow = () => (
    <Box flexDirection="row">
      {vertical.left ? <Text color="#64748b">{vertical.left}</Text> : null}
      {header.map((cell, index) => (
        <React.Fragment key={index}>
          <Box width={columnWidths[index]}>
            <Text bold>{renderCellContent(cell, columnWidths[index], columnAlignment[index] || 'left')}</Text>
          </Box>
          {index < numCols - 1 && <Text color="#64748b">{vertical.middle}</Text>}
        </React.Fragment>
      ))}
      {vertical.right ? <Text color="#64748b">{vertical.right}</Text> : null}
    </Box>
  );

  // Render data row
  const renderDataRow = (row: TableCell[]) => (
    <Box flexDirection="row">
      {vertical.left ? <Text color="#64748b">{vertical.left}</Text> : null}
      {row.map((cell, index) => (
        <React.Fragment key={index}>
          <Box width={columnWidths[index]}>
            {renderCellContent(cell, columnWidths[index], columnAlignment[index] || 'left')}
          </Box>
          {index < numCols - 1 && <Text color="#64748b">{vertical.middle}</Text>}
        </React.Fragment>
      ))}
      {vertical.right ? <Text color="#64748b">{vertical.right}</Text> : null}
    </Box>
  );

  // Separator between header and data (only for bordered styles)
  const renderSeparator = () => {
    return (
      <Box marginX={1}>
        <Text color="#64748b">{borders.middle}</Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* Top border */}
      <Box marginX={1}>
        <Text color="#64748b">{borders.top}</Text>
      </Box>

      {/* Header */}
      <Box marginX={1}>{renderHeaderRow()}</Box>

      {/* Separator */}
      {renderSeparator()}

      {/* Data rows */}
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} marginX={1}>
          {renderDataRow(row)}
        </Box>
      ))}

      {/* Bottom border */}
      <Box marginX={1}>
        <Text color="#64748b">{borders.bottom}</Text>
      </Box>
    </Box>
  );
};

// --- Token Renderers ---

// recursively render inline content (bold, italic, links, etc.)
const InlineContent = ({ tokens }: { tokens: any[] }) => {
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
              return <InlineContent key={key} tokens={token.tokens} />;
            }
            return <Text key={key}>{token.text}</Text>;

          case 'strong':
            return (
              <Text key={key} bold>
                <InlineContent tokens={token.tokens} />
              </Text>
            );

          case 'em':
            return (
              <Text key={key} italic>
                <InlineContent tokens={token.tokens} />
              </Text>
            );

          case 'codespan':
            return (
              <Text key={key} color="yellow" backgroundColor="#333">
                {` ${token.text} `}
              </Text>
            );

          case 'link':
            return (
              <Text key={key} color="#3b82f6" underline>
                {token.text}
              </Text>
            );

          case 'image':
            return (
              <Text key={key} color="#64748b">
                {' '}
                [Image: {token.text}]{' '}
              </Text>
            );

          case 'br':
            return <Newline key={key} />;

          default:
            return <Text key={key}>{token.raw}</Text>;
        }
      })}
    </>
  );
};

// Render Block elements (Headings, Paragraphs, Lists)
const BlockRenderer = ({ token }: { token: any }) => {
  switch (token.type) {
    case 'heading':
      const isMain = token.depth === 1;
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text bold underline={isMain} color={isMain ? 'green' : 'cyan'}>
            {isMain ? '# ' : '## '}
            <InlineContent tokens={token.tokens} />
          </Text>
        </Box>
      );

    case 'paragraph':
      return (
        <Box marginBottom={1}>
          <Text>
            <InlineContent tokens={token.tokens} />
          </Text>
        </Box>
      );

    case 'list':
      return (
        <Box flexDirection="column" marginBottom={1}>
          {token.items.map((item: any, index: number) => (
            <BlockRenderer key={index} token={item} />
          ))}
        </Box>
      );

    case 'list_item':
      return (
        <Box flexDirection="row">
          <Box marginRight={1}>
            <Text color="green">•</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {/* List items can contain multiple block tokens (like sub-lists or paragraphs) */}
            {token.tokens.map((subToken: any, i: number) => {
              // If it's just text inside the list item, marked might wrap it in a generic block
              if (subToken.type === 'text') {
                return (
                  <Text key={i}>
                    <InlineContent tokens={subToken.tokens} />
                  </Text>
                );
              }
              return <BlockRenderer key={i} token={subToken} />;
            })}
          </Box>
        </Box>
      );

    case 'code':
      return (
        <Box borderStyle="round" borderColor="#64748b" paddingX={1} marginBottom={1} flexDirection="column">
          <Text color="yellow">{token.text}</Text>
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
          marginBottom={1}
          flexDirection="column"
        >
          {/* Blockquotes often contain nested paragraphs which render as Boxes */}
          {/* We cannot wrap them in Text because Box in Text causes a crash */}
          {token.tokens.map((t: any, i: number) => (
            <BlockRenderer key={i} token={t} />
          ))}
        </Box>
      );

    case 'space':
      return null;

    case 'hr':
      return (
        <Box marginY={1}>
          <Text color="#64748b">────────────────────────────────────────</Text>
        </Box>
      );

    case 'table':
      return <TableRenderer token={token} />;

    default:
      // Fallback for unknown blocks
      // console.log(`Unknown token type: ${token.type}`);
      return null;
  }
};

// --- Main Component ---

interface MarkdownRendererProps {
  children?: React.ReactNode;
  tokens?: any[];
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

const MarkdownRenderer = ({ children, tokens }: MarkdownRendererProps) => {
  // Allow passing raw text (which we parse) OR pre-parsed tokens
  const ast = useMemo(() => tokens || marked.lexer(String(children || '')), [tokens, children]);

  return (
    <Box flexDirection="column">
      {ast.map((token: any, index: number) => (
        <BlockRenderer key={getTokenKey(token, index)} token={token} />
      ))}
    </Box>
  );
};

export default MarkdownRenderer;
