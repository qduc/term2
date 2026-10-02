import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { SelectionMarker } from '../../components/common/SelectionMarker.js';
import { GLYPH_FAVORITE, useTheme } from '../../components/theme.js';
import type { QuestionPromptProps } from '../types.js';
import { TwoPaneApprovalLayout } from './approval.js';

/** A boxed question over a numbered list, with the selected option explained beside it. */
export const ClassicQuestionPrompt: FC<QuestionPromptProps> = ({
  progress,
  question,
  notice,
  options,
  description,
  footer,
}) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      {progress !== undefined && (
        <Box marginLeft={1}>
          <Text color={theme.textSubtle}>{progress}</Text>
        </Box>
      )}
      <Box borderStyle="round" borderColor={theme.warning} paddingX={1} paddingY={0}>
        <Text color={theme.warning} bold>
          {question}
        </Text>
      </Box>
      {notice !== undefined && (
        <Box marginTop={1} marginLeft={1}>
          <Text color={theme.accent}>❯ {notice}</Text>
        </Box>
      )}
      <TwoPaneApprovalLayout
        left={options.map((option, index) => {
          const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
          return (
            <Box key={option.label} flexDirection="row" width="100%">
              <SelectionMarker selected={option.selected} />
              <Box width={2} flexShrink={0}>
                <Text color={theme.textSubtle} dimColor>
                  {option.recommended ? GLYPH_FAVORITE : ' '}
                </Text>
              </Box>
              <Box flexDirection="row" flexShrink={1} flexWrap="wrap">
                <Text color={option.selected && option.tone ? theme[option.tone] : undefined} bold={option.selected}>
                  {index + 1}. {checkbox}
                  {option.label}
                </Text>
              </Box>
            </Box>
          );
        })}
        rightTitle={description.title}
        rightDescription={description.text}
      />
      <Box marginTop={1} marginLeft={1}>
        {footer}
      </Box>
    </Box>
  );
};
