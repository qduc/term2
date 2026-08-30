import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseCodeContextSearchOutput } from './command-message-helpers.js';
import { COLOR_TEXT, COLOR_TEXT_MUTED, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const CodeContextSearchRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const parsed = parseCodeContextSearchOutput(output) as any;
  if (!parsed) return null;

  const { queryType } = parsed;
  if (queryType === 'related') {
    const { target: _target, relatedFiles } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        {!relatedFiles || relatedFiles.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={COLOR_TEXT_SUBTLE}>No related files found.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" paddingLeft={2}>
            {relatedFiles.map((f: any, idx: number) => (
              <Box key={idx} flexDirection="column" marginBottom={0.5}>
                <Text color={COLOR_TEXT}>{f.filePath}</Text>
                <Text color={COLOR_TEXT_SUBTLE} dimColor>
                  {' '}
                  Relations: {f.relations}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  } else {
    const { symbol: _symbol, results } = parsed;
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>{renderStandardHeader()}</Box>
        {!results || results.length === 0 ? (
          <Box paddingLeft={2}>
            <Text color={COLOR_TEXT_SUBTLE}>No symbol declarations found.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" paddingLeft={2}>
            {results.map((res: any, idx: number) => (
              <Text key={idx}>
                <Text color={COLOR_TEXT}>
                  {res.filePath}:{res.lineNum}
                </Text>
                <Text color={COLOR_TEXT_SUBTLE} dimColor>
                  {' '}
                  │{' '}
                </Text>
                <Text color={COLOR_WARNING}>
                  {res.kind} {res.name}
                </Text>
                {res.exported && (
                  <Text color={COLOR_TEXT_MUTED} dimColor>
                    {' '}
                    (exported)
                  </Text>
                )}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }
};

export default CodeContextSearchRenderer;
