import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseWebSearchOutput } from './command-message-helpers.js';
import { COLOR_TOOL_OUTPUT } from '../theme.js';

const COLOR_WARNING = 'yellow';
const COLOR_INFO = 'cyan';
const COLOR_CONTENT = 'white';
const COLOR_LINK = 'blue';
const COLOR_MUTED = 'gray';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const WebSearchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const parsed = parseWebSearchOutput(output) as any;
  if (!parsed) return null;

  const { answer, results } = parsed;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>{renderStandardHeader()}</Box>
      {answer && (
        <Box flexDirection="column" borderStyle="round" borderColor={COLOR_WARNING} paddingX={1} marginBottom={1}>
          <Text color={COLOR_WARNING} bold>
            Answer Summary
          </Text>
          <Text color={COLOR_TOOL_OUTPUT}>{answer}</Text>
        </Box>
      )}
      {results && results.length > 0 && (
        <Box flexDirection="column">
          <Text color={COLOR_INFO} bold>
            Search Results:
          </Text>
          {results.map((res: any, idx: number) => (
            <Box key={idx} flexDirection="column" marginTop={1} paddingLeft={2}>
              <Text bold color={COLOR_CONTENT}>
                {idx + 1}. {res.title}
              </Text>
              <Text color={COLOR_LINK} underline>
                {res.url}
              </Text>
              {res.published && (
                <Text color={COLOR_MUTED} dimColor>
                  Published: {res.published}
                </Text>
              )}
              <Box marginTop={1}>
                <Text color={COLOR_TOOL_OUTPUT}>{res.content}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default WebSearchRenderer;
