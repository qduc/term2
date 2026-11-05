import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseWebSearchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const WebSearchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const theme = useTheme();
  const { ToolSection } = useSkin();
  const parsed = parseWebSearchOutput(output) as any;
  if (!parsed) return null;

  const { answer, results } = parsed;
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>{renderStandardHeader()}</Box>
      {answer && (
        <Box flexDirection="column" marginBottom={1}>
          <ToolSection variant="callout" title="Answer Summary" tone="warning">
            <Text color={theme.toolOutput}>{answer}</Text>
          </ToolSection>
        </Box>
      )}
      {results && results.length > 0 && (
        <Box flexDirection="column">
          <Text color={theme.accent} bold>
            Search Results:
          </Text>
          {results.map((res: any, idx: number) => (
            <Box key={idx} flexDirection="column" marginTop={1}>
              <ToolSection variant="indent">
                <Text bold color={theme.text}>
                  {idx + 1}. {res.title}
                </Text>
                <Text color={theme.accent} underline>
                  {res.url}
                </Text>
                {res.published && (
                  <Text color={theme.textSubtle} dimColor>
                    Published: {res.published}
                  </Text>
                )}
                <Box marginTop={1}>
                  <Text color={theme.toolOutput}>{res.content}</Text>
                </Box>
              </ToolSection>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default WebSearchRenderer;
