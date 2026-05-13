import React, { FC } from 'react';
import { Box } from 'ink';
import MarkdownRenderer from './MarkdownRenderer.js';

type Props = {
  text: string;
};

/**
 * LiveResponse displays streaming text with Markdown formatting.
 * Reasoning text is displayed in slate (#64748b) before the main response.
 */
const LiveResponse: FC<Props> = ({ text }) => {
  // Trim trailing empty lines
  const trimmedText = text.replace(/\n\s*$/, '');

  return (
    <Box marginY={1} flexDirection="column">
      <MarkdownRenderer>{trimmedText}</MarkdownRenderer>
    </Box>
  );
};

export default LiveResponse;
