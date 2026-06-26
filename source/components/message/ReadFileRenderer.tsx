import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseReadFileOutput } from './command-message-helpers.js';
import { COLOR_TOOL_OUTPUT } from '../theme.js';

const COLOR_MUTED = 'gray';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const ReadFileRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
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
      <Box flexDirection="column" borderStyle="single" borderColor={COLOR_MUTED} paddingX={1} marginTop={1}>
        {displayLines.map((line, idx) => {
          if (line.lineNum === -1) {
            return (
              <Box key={idx} flexDirection="row">
                <Box width={8} flexShrink={0}>
                  <Text color={COLOR_MUTED} dimColor>
                    {'      │ '}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={COLOR_MUTED} dimColor>
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
                <Text color={COLOR_MUTED} dimColor>
                  {lineNumStr} │{' '}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text color={COLOR_TOOL_OUTPUT}>{line.content}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};

export default ReadFileRenderer;
