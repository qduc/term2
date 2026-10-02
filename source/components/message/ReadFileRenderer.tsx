import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseReadFileOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const ReadFileRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const theme = useTheme();
  const { ToolSection } = useSkin();
  const parsed = parseReadFileOutput(output) as any;
  if (!parsed) return null;

  const { filePath: _filePath, totalLines: _totalLines, startLine, endLine: _endLine, contentLines } = parsed;
  const maxContentLines = 10;
  const displayLines: { lineNum: number; content: string }[] = [];
  let truncatedCount = 0;

  if (contentLines.length > maxContentLines + 1) {
    const topCount = maxContentLines - 1;
    for (let i = 0; i < topCount; i++) {
      displayLines.push({ lineNum: startLine + i, content: contentLines[i] ?? '' });
    }
    truncatedCount = contentLines.length - topCount - 1;
    displayLines.push({ lineNum: -1, content: `... (${truncatedCount} lines truncated) ...` });
    displayLines.push({
      lineNum: startLine + contentLines.length - 1,
      content: contentLines[contentLines.length - 1] ?? '',
    });
  } else {
    contentLines.forEach((content: string, i: number) => {
      displayLines.push({ lineNum: startLine + i, content });
    });
  }

  return (
    <Box flexDirection="column">
      {renderStandardHeader()}
      <Box flexDirection="column" marginTop={1}>
        <ToolSection variant="panel">
          {displayLines.map((line, idx) => {
            if (line.lineNum === -1) {
              return (
                <Box key={idx} flexDirection="row">
                  <Box width={8} flexShrink={0}>
                    <Text color={theme.textSubtle} dimColor>
                      {'      │ '}
                    </Text>
                  </Box>
                  <Box flexGrow={1}>
                    <Text color={theme.textSubtle} dimColor>
                      {line.content}
                    </Text>
                  </Box>
                </Box>
              );
            }
            const lineNumStr = String(line.lineNum).padStart(5, ' ');
            return (
              <Box key={idx} flexDirection="row">
                <Box width={8} flexShrink={0}>
                  <Text color={theme.textSubtle} dimColor>
                    {lineNumStr} │{' '}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={theme.toolOutput}>{line.content}</Text>
                </Box>
              </Box>
            );
          })}
        </ToolSection>
      </Box>
    </Box>
  );
};

export default ReadFileRenderer;
