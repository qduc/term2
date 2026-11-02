import React, { useMemo } from 'react';
import { Box, Text, Newline } from 'ink';
import { marked } from 'marked';
import { useTheme } from './theme.js';
import { TableRenderer } from './MarkdownTable.js';

export type MarkdownRenderOptions = {
  defaultColor?: string;
  dimColor?: boolean;
};

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

const CODE_LINE_START_PATTERN =
  /^(?:if|for|while|switch|try|catch|else|const|let|var|function|class|interface|type|enum|import|export|return|throw|await|async|def|from|public|private|protected|static|final|package|func|fn|impl|use|echo|cd|npm|npx|yarn|pnpm|sudo|curl|git|<|[{([/@#*$])/;

const normalizeJoinedFenceCodeLines = (markdown: string): string => {
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

// --- Table Rendering Utilities ---

// --- Token Renderers ---

/**
 * A code span is a chip: its text sits on the code background, with one padding column on a side only where an
 * ordinary space stood. The chip's padding then replaces that space, so the line reads with single spaces
 * (with or without a visible background) and no stray space lands before punctuation (`hi.` stays `hi.`).
 */
function absorbChipSpaces(tokens: any[]): any[] {
  const plain = (token: any) =>
    (token?.type === 'text' || token?.type === 'escape') && !token.tokens && typeof token.text === 'string';
  // Formatting wrappers are transparent at their edges: **`code`** borrows a
  // neighboring space just like `code`, but prose inside the wrapper does not.
  const edgeChip = (token: any, side: 'left' | 'right'): boolean => {
    if (token?.type === 'codespan') return true;
    if (!['strong', 'em', 'text'].includes(token?.type) || !token.tokens?.length) return false;
    return edgeChip(token.tokens[side === 'left' ? 0 : token.tokens.length - 1], side);
  };
  const padEdge = (token: any, side: 'left' | 'right'): any => {
    if (token.type === 'codespan') return { ...token, [side === 'left' ? 'padLeft' : 'padRight']: true };
    const index = side === 'left' ? 0 : token.tokens.length - 1;
    return {
      ...token,
      tokens: token.tokens.map((child: any, i: number) => (i === index ? padEdge(child, side) : child)),
    };
  };
  return tokens.map((token, index) => {
    const left = edgeChip(token, 'left');
    const right = edgeChip(token, 'right');
    if (left || right) {
      // A single space between chips belongs to the first, even across formatting.
      const sharedSpace = edgeChip(tokens[index - 2], 'right') && tokens[index - 1]?.text === ' ';
      const padLeft = left && plain(tokens[index - 1]) && tokens[index - 1].text.endsWith(' ') && !sharedSpace;
      const padRight = right && plain(tokens[index + 1]) && tokens[index + 1].text.startsWith(' ');
      let result = token;
      if (padLeft) result = padEdge(result, 'left');
      if (padRight) result = padEdge(result, 'right');
      return result;
    }
    if (!plain(token)) return token;
    let text: string = token.text;
    if (edgeChip(tokens[index + 1], 'left') && text.endsWith(' ')) text = text.slice(0, -1);
    if (edgeChip(tokens[index - 1], 'right') && text.startsWith(' ')) text = text.slice(1);
    return text === token.text ? token : { ...token, text };
  });
}

// recursively render inline content (bold, italic, links, etc.)
const InlineContent = ({ tokens: rawTokens, options = {} }: { tokens: any[]; options?: MarkdownRenderOptions }) => {
  const theme = useTheme();
  if (!rawTokens) return null;
  const tokens = absorbChipSpaces(rawTokens);

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
              <Text key={key} color={theme.warning} backgroundColor={theme.codeBackground} dimColor={options.dimColor}>
                {`${token.padLeft ? ' ' : ''}${token.text}${token.padRight ? ' ' : ''}`}
              </Text>
            );

          case 'link':
            return (
              <Text key={key} color={theme.accent} underline dimColor={options.dimColor}>
                {token.text}
              </Text>
            );

          case 'image':
            return (
              <Text key={key} color={theme.textSubtle} dimColor={options.dimColor}>
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
  const theme = useTheme();
  switch (token.type) {
    case 'heading': {
      const isMain = token.depth === 1;
      const hasTrailingBlankLine = token.raw && token.raw.endsWith('\n\n');
      return (
        <Box flexDirection="column">
          <Text bold underline={isMain} color={isMain ? theme.success : theme.accent} dimColor={options.dimColor}>
            {'#'.repeat(token.depth) + ' '}
            <InlineContent tokens={token.tokens} options={options} />
          </Text>
          {hasTrailingBlankLine && <Box height={1} />}
        </Box>
      );
    }

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
            <Text color={theme.success} dimColor={options.dimColor}>
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
        <Box borderStyle="round" borderColor={theme.textSubtle} paddingX={1} flexDirection="column" width={maxWidth}>
          <Text color={theme.warning} dimColor={options.dimColor}>
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
          borderColor={theme.accent}
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
      return <Box height={1} />;

    case 'hr':
      return (
        <Box>
          <Text color={theme.textSubtle} dimColor={options.dimColor}>
            ────────────────────────────────────────
          </Text>
        </Box>
      );

    case 'table': {
      const hasTableTrailingBlankLine = token.raw && token.raw.endsWith('\n\n');
      return (
        <Box flexDirection="column">
          <TableRenderer token={token} options={options} maxWidth={maxWidth} />
          {hasTableTrailingBlankLine && <Box height={1} />}
        </Box>
      );
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
  const ast = useMemo(
    () => tokens || marked.lexer(normalizeJoinedFenceCodeLines(String(children || ''))),
    [tokens, children],
  );
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
