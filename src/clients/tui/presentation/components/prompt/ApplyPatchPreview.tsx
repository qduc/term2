import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';

/** The approval prompt's paged view of an `apply_patch` call; paging keys stay in the prompt. */
const ApplyPatchPreview: FC<{ lines: string[]; page: number; pages: number }> = ({ lines, page, pages }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text
          key={index}
          color={line.startsWith('+') ? theme.success : line.startsWith('-') ? theme.danger : undefined}
        >
          {line || ' '}
        </Text>
      ))}
      <Text color={theme.textSubtle}>
        Patch preview {page + 1}/{pages} — [ / ] previous / next page
      </Text>
    </Box>
  );
};

export default ApplyPatchPreview;
