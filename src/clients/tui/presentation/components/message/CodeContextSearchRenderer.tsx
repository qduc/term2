import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseCodeContextSearchOutput } from './command-message-helpers.js';
import { useTheme } from '../theme.js';
import { useSkin } from '../../skins/SkinContext.js';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const CodeContextSearchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const theme = useTheme();
  const { ToolSection } = useSkin();
  const parsed = parseCodeContextSearchOutput(output) as any;
  if (!parsed) return null;

  const { queryType } = parsed;
  if (queryType === 'related') {
    const { target: _target, relatedFiles } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        {!relatedFiles || relatedFiles.length === 0 ? (
          <ToolSection variant="indent">
            <Text color={theme.textSubtle}>No related files found.</Text>
          </ToolSection>
        ) : (
          <ToolSection variant="indent">
            {relatedFiles.map((f: any, idx: number) => (
              <Box key={idx} flexDirection="column" marginBottom={0.5}>
                <Text color={theme.text}>{f.filePath}</Text>
                <Text color={theme.textSubtle} dimColor>
                  {' '}
                  Relations: {f.relations}
                </Text>
              </Box>
            ))}
          </ToolSection>
        )}
      </Box>
    );
  } else {
    const { symbol: _symbol, results } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        {!results || results.length === 0 ? (
          <ToolSection variant="indent">
            <Text color={theme.textSubtle}>No symbol declarations found.</Text>
          </ToolSection>
        ) : (
          <ToolSection variant="indent">
            {results.map((res: any, idx: number) => (
              <Text key={idx}>
                <Text color={theme.text}>
                  {res.filePath}:{res.lineNum}
                </Text>
                <Text color={theme.textSubtle} dimColor>
                  {' '}
                  │{' '}
                </Text>
                <Text color={theme.warning}>
                  {res.kind} {res.name}
                </Text>
                {res.exported && (
                  <Text color={theme.textMuted} dimColor>
                    {' '}
                    (exported)
                  </Text>
                )}
              </Text>
            ))}
          </ToolSection>
        )}
      </Box>
    );
  }
};

export default CodeContextSearchRenderer;
