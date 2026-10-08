import React, { FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

const LABEL = ' New conversation ';

/**
 * A full-width labelled rule printed where a reset (/clear, mode switch,
 * rollover) starts a fresh session. The earlier output stays in scrollback, so
 * without this the new banner looks like a continuation of the old transcript.
 */
const SessionBoundary: FC<{ width: number }> = ({ width }) => {
  const theme = useTheme();
  const columns = Math.max(LABEL.length + 4, width);
  const side = Math.max(2, Math.floor((columns - LABEL.length) / 2));
  const rule = (count: number) => '─'.repeat(count);
  return (
    <Box marginTop={2} marginBottom={1} width="100%">
      <Text color={theme.textSubtle} wrap="truncate-end">
        {rule(side)}
        <Text color={theme.accent} bold>
          {LABEL}
        </Text>
        {rule(Math.max(2, columns - side - LABEL.length))}
      </Text>
    </Box>
  );
};

export default SessionBoundary;
