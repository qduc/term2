import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import type { MenuFrameProps, QuestionPromptProps, SubagentFeedProps, ToolSectionProps } from '../types.js';
import { Chip } from './chip.js';

/** A solid `ASK` chip leads the question; options are rows with a fixed-width number column. */
export const LedgerQuestionPrompt: FC<QuestionPromptProps> = ({
  progress,
  question,
  notice,
  options,
  description,
  footer,
}) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box flexShrink={0} marginRight={1}>
          <Chip solid tone="warning">
            ASK
          </Chip>
        </Box>
        <Box flexShrink={1}>
          <Text bold>{question}</Text>
        </Box>
      </Box>
      {progress !== undefined && <Text color={theme.textSubtle}>{progress}</Text>}
      {notice !== undefined && <Text color={theme.accent}>❯ {notice}</Text>}
      {options.map((option, index) => {
        const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
        return (
          <Box key={option.label}>
            <Box width={2} flexShrink={0}>
              <Text color={theme.accent} bold>
                {option.selected ? GLYPH_SELECTED : ' '}
              </Text>
            </Box>
            <Box width={3} flexShrink={0}>
              <Text color={option.tone ? theme[option.tone] : theme.textSubtle} bold>
                {index + 1}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Text color={option.selected && option.tone ? theme[option.tone] : undefined} bold={option.selected}>
                {checkbox}
                {option.label}
                {option.recommended ? ` ${GLYPH_FAVORITE}` : ''}
              </Text>
            </Box>
          </Box>
        );
      })}
      {description.text !== undefined && description.text !== '' && (
        <Box>
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.textSubtle}>↳</Text>
          </Box>
          <Text color={theme.textSubtle}>{description.text}</Text>
        </Box>
      )}
      <Box marginTop={1}>{footer}</Box>
    </Box>
  );
};

/** An `AGENT` chip and the task on one line; its latest calls indented beneath. */
export const LedgerSubagentFeed: FC<SubagentFeedProps> = ({ title, statusSuffix, tone, summary, children }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Box>
        <Box flexShrink={0} marginRight={1}>
          <Chip tone={tone} bold>
            AGENT
          </Chip>
        </Box>
        <Box flexShrink={1}>
          <Text color={theme[tone]}>
            {title}
            {statusSuffix}
          </Text>
        </Box>
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {summary !== undefined ? <Text color={theme.textSubtle}>{summary}</Text> : children}
      </Box>
    </Box>
  );
};

/** Rows indent; a panel hangs off a `│` margin; a callout opens with a chip. */
export const LedgerToolSection: FC<ToolSectionProps> = ({ variant, title, tone = 'warning', children }) => {
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
      <Box
        flexDirection="column"
        paddingLeft={1}
        marginLeft={1}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={theme.border}
      >
        {children}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {title !== undefined && (
        <Box alignSelf="flex-start">
          <Chip solid tone={tone}>
            {title}
          </Chip>
        </Box>
      )}
      {children}
    </Box>
  );
};

/** A square box, title as a chip on its first line, hints under a hairline or below. */
export const LedgerMenuFrame: FC<MenuFrameProps> = ({ title, borderColor, footer, footerPlacement, children }) => {
  const theme = useTheme();
  const footerNode = footer ? (
    typeof footer === 'string' ? (
      <Text color={theme.textSubtle}>{footer}</Text>
    ) : (
      footer
    )
  ) : null;
  const body = (
    <Box
      borderStyle="single"
      borderColor={borderColor ?? theme.borderActive}
      paddingX={1}
      flexDirection="column"
      width="100%"
    >
      {title ? (
        <Box alignSelf="flex-start">
          <Chip tone="textMuted" bold>
            {title}
          </Chip>
        </Box>
      ) : null}
      {children}
      {footerPlacement === 'inside' && footerNode && <Box marginTop={1}>{footerNode}</Box>}
    </Box>
  );
  return (
    <Box flexDirection="column" width="100%">
      {body}
      {footerPlacement === 'outside' && footerNode}
    </Box>
  );
};
