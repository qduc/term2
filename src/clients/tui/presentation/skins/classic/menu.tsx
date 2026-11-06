import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import type { MenuFrameProps } from '../types.js';

/** A rounded box; hints go under a hairline inside it, or below it. */
export const ClassicMenuFrame: FC<MenuFrameProps> = ({
  title,
  borderColor,
  hasItems,
  footer,
  footerPlacement,
  children,
}) => {
  const theme = useTheme();
  const color = borderColor ?? theme.borderActive;
  const footerNode = footer ? (
    typeof footer === 'string' ? (
      <Text color={theme.textSubtle}>{footer}</Text>
    ) : (
      footer
    )
  ) : null;
  const body = (
    <Box
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      flexDirection="column"
      width={hasItems ? '100%' : undefined}
    >
      {title ? <Text color={theme.textSubtle}>{title}</Text> : null}
      {children}
      {footerPlacement === 'inside' && footerNode && (
        <Box
          marginTop={1}
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.border}
        >
          {footerNode}
        </Box>
      )}
    </Box>
  );
  if (footerPlacement === 'outside' && footerNode) {
    return (
      <Box flexDirection="column" width="100%">
        {body}
        {footerNode}
      </Box>
    );
  }
  return body;
};
