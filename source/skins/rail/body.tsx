import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import type { MenuFrameProps, QuestionPromptProps, SubagentFeedProps, ToolSectionProps } from '../types.js';
import { Hairline, RAIL_HEAVY, RAIL_THIN, Rail } from './parts.js';

/**
 * The question sits behind a heavy warning rail, like an approval; its options are
 * the same numbered list the approval uses, the selected one explained in one dim
 * line under the list rather than in a side pane.
 */
export const RailQuestionPrompt: FC<QuestionPromptProps> = ({
  progress,
  question,
  notice,
  options,
  description,
  footer,
}) => {
  const theme = useTheme();
  return (
    <Rail glyph={RAIL_HEAVY} color={theme.warning}>
      {progress !== undefined && <Text color={theme.textSubtle}>{progress}</Text>}
      <Text bold color={theme.warning}>
        {question}
      </Text>
      {notice !== undefined && <Text color={theme.accent}>❯ {notice}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
          const tone = option.tone ? theme[option.tone] : undefined;
          const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
          return (
            <Box key={option.label}>
              <Box width={2} flexShrink={0}>
                <Text color={theme.accent} bold>
                  {option.selected ? GLYPH_SELECTED : ' '}
                </Text>
              </Box>
              <Box width={2} flexShrink={0}>
                <Text color={theme.textSubtle}>{option.recommended ? GLYPH_FAVORITE : ' '}</Text>
              </Box>
              <Box flexShrink={1}>
                <Text color={option.selected ? tone : theme.textMuted} bold={option.selected}>
                  {index + 1}. {checkbox}
                  {option.label}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      {description.text && (
        <Box marginTop={1}>
          <Text color={theme.textSubtle} italic>
            {description.text}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>{footer}</Box>
    </Rail>
  );
};

/** A thin rail in the status colour down the whole feed, so it reads as one unit apart from the answer. */
export const RailSubagentFeed: FC<SubagentFeedProps> = ({ title, statusSuffix, tone, summary, children }) => {
  const theme = useTheme();
  return (
    <Rail glyph={RAIL_THIN} color={theme[tone]}>
      <Text color={theme[tone]} bold>
        {title}
        {statusSuffix}
      </Text>
      {summary !== undefined ? <Text color={theme.textSubtle}>{summary}</Text> : children}
    </Rail>
  );
};

/**
 * Renderer bodies always sit inside the tool call's own rail, so a second rail here
 * would double it. Rows and content blocks indent; a callout opens with a bold
 * heading in its tone.
 */
export const RailToolSection: FC<ToolSectionProps> = ({ variant, title, tone = 'warning', children }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {variant === 'callout' && title !== undefined && (
        <Text color={theme[tone]} bold>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
};

/** Hairlines above and below, no box; a state colour (error) tints the title instead of a border. */
export const RailMenuFrame: FC<MenuFrameProps> = ({ title, borderColor, footer, footerPlacement, children }) => {
  const theme = useTheme();
  const footerNode = footer ? (
    typeof footer === 'string' ? (
      <Text color={theme.textSubtle}>{footer}</Text>
    ) : (
      footer
    )
  ) : null;
  return (
    <Box flexDirection="column" width="100%">
      <Hairline />
      {title ? (
        <Text bold color={borderColor === theme.danger ? theme.danger : theme.textMuted}>
          {title}
        </Text>
      ) : null}
      {children}
      {footerPlacement === 'inside' && footerNode}
      <Hairline />
      {footerPlacement === 'outside' && footerNode}
    </Box>
  );
};
