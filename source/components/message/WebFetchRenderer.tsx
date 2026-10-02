import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseWebFetchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const WebFetchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const theme = useTheme();
  const { ToolSection } = useSkin();
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
      <ToolSection variant="indent">
        {title && (
          <Text color={theme.text} bold>
            {title}
          </Text>
        )}
        <Text color={theme.accent} underline>
          {url}
        </Text>
      </ToolSection>
      {toc && (
        <Box flexDirection="column" marginY={1} width={50}>
          <ToolSection variant="callout" title="Table of Contents" tone="warning">
            <Text color={theme.textSubtle}>{toc}</Text>
          </ToolSection>
        </Box>
      )}
      {content && (
        <Box flexDirection="column" marginTop={1}>
          <ToolSection variant="panel">
            <Text color={theme.toolOutput}>{displayContent}</Text>
          </ToolSection>
        </Box>
      )}
      {tempFile && (
        <Box marginTop={1}>
          <Text color={theme.warning}>
            Full content saved to:{' '}
            <Text bold color={theme.text}>
              {tempFile}
            </Text>
          </Text>
        </Box>
      )}
      {notes && (
        <Box marginTop={0.5}>
          <Text color={theme.warning}>Warning: {notes}</Text>
        </Box>
      )}
    </Box>
  );
};

export default WebFetchRenderer;
