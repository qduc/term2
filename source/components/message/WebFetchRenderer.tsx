import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseWebFetchOutput } from './command-message-helpers.js';
import { COLOR_TOOL_OUTPUT } from '../theme.js';

const COLOR_CONTENT = 'white';
const COLOR_LINK = 'blue';
const COLOR_MUTED = 'gray';
const COLOR_WARNING = 'yellow';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const WebFetchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const parsed = parseWebFetchOutput(output) as any;
  if (!parsed) return null;

  const { title, url, toc, tempFile, notes, content } = parsed;
  const maxLines = 15;
  const contentLines = content.split('\n');
  let displayContent = content;
  let truncatedCount = 0;
  if (contentLines.length > maxLines + 1) {
    const firstPart = contentLines.slice(0, maxLines).join('\n');
    const lastLine = contentLines[contentLines.length - 1];
    truncatedCount = contentLines.length - maxLines - 1;
    displayContent = `${firstPart}\n\n... (${truncatedCount} lines of content truncated for preview) ...\n\n${lastLine}`;
  }
  return (
    <Box flexDirection="column">
      {renderStandardHeader()}
      {title && (
        <Box paddingLeft={2}>
          <Text color={COLOR_CONTENT} bold>
            {title}
          </Text>
        </Box>
      )}
      <Box paddingLeft={2}>
        <Text color={COLOR_LINK} underline>
          {url}
        </Text>
      </Box>
      {toc && (
        <Box flexDirection="column" borderStyle="classic" borderColor={COLOR_MUTED} paddingX={1} marginY={1} width={50}>
          <Text color={COLOR_WARNING} bold>
            Table of Contents
          </Text>
          <Text color={COLOR_MUTED}>{toc}</Text>
        </Box>
      )}
      {content && (
        <Box flexDirection="column" borderStyle="single" borderColor={COLOR_MUTED} paddingX={1} marginTop={1}>
          <Text color={COLOR_TOOL_OUTPUT}>{displayContent}</Text>
        </Box>
      )}
      {tempFile && (
        <Box marginTop={1}>
          <Text color={COLOR_WARNING}>
            Full content saved to:{' '}
            <Text bold color={COLOR_CONTENT}>
              {tempFile}
            </Text>
          </Text>
        </Box>
      )}
      {notes && (
        <Box marginTop={0.5}>
          <Text color={COLOR_WARNING}>Warning: {notes}</Text>
        </Box>
      )}
    </Box>
  );
};

export default WebFetchRenderer;
