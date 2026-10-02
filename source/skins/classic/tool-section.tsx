import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { ToolSectionProps } from '../types.js';

/**
 * `indent` sits two columns in, `panel` is a single-line box, `callout` a rounded
 * box with a bold heading. Spacing between sections stays with the renderer.
 */
export const ClassicToolSection: FC<ToolSectionProps> = ({ variant, title, tone = 'warning', children }) => {
  const theme = useTheme();
  if (variant === 'indent') {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    );
  }
  if (variant === 'panel') {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.textSubtle} paddingX={1}>
        {children}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme[tone]} paddingX={1}>
      {title !== undefined && (
        <Text color={theme[tone]} bold>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
};
