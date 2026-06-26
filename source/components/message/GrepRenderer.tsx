import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { parseGrepOutput } from './command-message-helpers.js';
import { COLOR_TOOL_OUTPUT } from '../theme.js';

const COLOR_INFO = 'cyan';
const COLOR_MUTED = 'gray';
const COLOR_WARNING = 'yellow';

type Props = {
  output: string;
  renderStandardHeader: () => React.ReactElement;
};

const GrepRenderer: FC<Props> = ({ output, renderStandardHeader }) => {
  const parsed = parseGrepOutput(output) as any;
  if (!parsed) return null;

  const { matchesByFile, note } = parsed;
  const filePaths = Object.keys(matchesByFile);

  const MAX_DISPLAY_MATCHES = 10;
  let displayedMatchesCount = 0;
  let truncatedMatchesCount = 0;
  let truncatedFilesCount = 0;

  const filesToRender: {
    filePath: string;
    matches: any[];
    truncatedCount: number;
  }[] = [];

  for (const filePath of filePaths) {
    const matches = matchesByFile[filePath] ?? [];
    if (displayedMatchesCount >= MAX_DISPLAY_MATCHES) {
      truncatedMatchesCount += matches.length;
      truncatedFilesCount++;
    } else {
      const remainingSlots = MAX_DISPLAY_MATCHES - displayedMatchesCount;
      if (matches.length <= remainingSlots) {
        filesToRender.push({
          filePath,
          matches,
          truncatedCount: 0,
        });
        displayedMatchesCount += matches.length;
      } else {
        filesToRender.push({
          filePath,
          matches: matches.slice(0, remainingSlots),
          truncatedCount: matches.length - remainingSlots,
        });
        displayedMatchesCount += remainingSlots;
        truncatedMatchesCount += matches.length - remainingSlots;
      }
    }
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>{renderStandardHeader()}</Box>
      {filesToRender.map((file, fileIdx) => {
        if (file.matches.length === 0) return null;
        return (
          <Box key={fileIdx} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={COLOR_INFO} bold>
                {file.filePath}
              </Text>
              <Text color={COLOR_MUTED}>
                {' '}
                ({file.matches.length} match{file.matches.length !== 1 ? 'es' : ''}
                {file.truncatedCount > 0 ? `, ${file.truncatedCount} truncated` : ''})
              </Text>
            </Box>
            <Box flexDirection="column" paddingLeft={2}>
              {file.matches.map((match: any, matchIdx: number) => {
                const lineNumStr = String(match.lineNum).padStart(4, ' ');
                return (
                  <Text key={matchIdx}>
                    <Text color={COLOR_MUTED} dimColor>
                      {lineNumStr}:{' '}
                    </Text>
                    <Text color={COLOR_TOOL_OUTPUT}>{match.content}</Text>
                  </Text>
                );
              })}
              {file.truncatedCount > 0 && (
                <Text color={COLOR_MUTED} dimColor>
                  ... ({file.truncatedCount} more match{file.truncatedCount !== 1 ? 'es' : ''} truncated in this file)
                  ...
                </Text>
              )}
            </Box>
          </Box>
        );
      })}
      {truncatedMatchesCount > 0 && (
        <Box marginTop={1}>
          <Text color={COLOR_WARNING}>
            ... ({truncatedMatchesCount} match{truncatedMatchesCount !== 1 ? 'es' : ''}
            {truncatedFilesCount > 0
              ? ` in ${truncatedFilesCount} more file${truncatedFilesCount !== 1 ? 's' : ''}`
              : ''}{' '}
            truncated) ...
          </Text>
        </Box>
      )}
      {note && (
        <Box marginTop={1}>
          <Text color={COLOR_WARNING}>{note}</Text>
        </Box>
      )}
    </Box>
  );
};

export default GrepRenderer;
