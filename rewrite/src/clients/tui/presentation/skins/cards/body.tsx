import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SELECTED, useTheme } from '../../components/theme.js';
import type { MenuFrameProps, QuestionPromptProps, SubagentFeedProps, ToolSectionProps } from '../types.js';
import { Card } from './card.js';

/** The question is the card's content; options are rows inside it, the selected one in its tone and bold. */
export const CardsQuestionPrompt: FC<QuestionPromptProps> = ({
  progress,
  question,
  notice,
  options,
  description,
  footer,
}) => {
  const theme = useTheme();
  return (
    <Card
      color={theme.warning}
      title={
        <Text color={theme.warning} bold wrap="truncate-end">
          {progress ?? 'Question'}
        </Text>
      }
    >
      <Text bold>{question}</Text>
      {notice !== undefined && <Text color={theme.accent}>❯ {notice}</Text>}
      <Box flexDirection="column" marginTop={1}>
        {options.map((option, index) => {
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
                <Text
                  color={option.selected && option.tone ? theme[option.tone] : undefined}
                  bold={option.selected}
                  inverse={option.selected && option.tone === undefined}
                >
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
          <Text color={theme.textSubtle}>{description.text}</Text>
        </Box>
      )}
      <Box marginTop={1}>{footer}</Box>
    </Card>
  );
};

/**
 * One card per run. The task and outcome are content that must not be clipped, so
 * they are the first line of the body; the border title only names the kind of card.
 */
export const CardsSubagentFeed: FC<SubagentFeedProps> = ({ title, statusSuffix, tone, summary, children }) => {
  const theme = useTheme();
  return (
    <Card
      color={theme[tone]}
      shape={tone === 'danger' ? 'bold' : 'round'}
      title={
        <Text color={theme[tone]} bold>
          subagent
        </Text>
      }
    >
      <Text color={theme[tone]}>
        {title}
        {statusSuffix}
      </Text>
      {summary !== undefined ? <Text color={theme.textSubtle}>{summary}</Text> : children}
    </Card>
  );
};

/** Content panels and callouts are cards; row runs are indented, so a list of matches does not become a stack of boxes. */
export const CardsToolSection: FC<ToolSectionProps> = ({ variant, title, tone = 'warning', children }) => {
  const theme = useTheme();
  if (variant === 'indent') {
    return (
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    );
  }
  if (variant === 'panel') {
    return <Card color={theme.textSubtle}>{children}</Card>;
  }
  return (
    <Card
      color={theme[tone]}
      title={
        title === undefined ? undefined : (
          <Text color={theme[tone]} bold wrap="truncate-end">
            {title}
          </Text>
        )
      }
    >
      {children}
    </Card>
  );
};

/** The same card as everything else, titled with the menu's name; hints sit under it. */
export const CardsMenuFrame: FC<MenuFrameProps> = ({ title, borderColor, footer, footerPlacement, children }) => {
  const theme = useTheme();
  const color = borderColor ?? theme.borderActive;
  const footerNode = footer ? (
    typeof footer === 'string' ? (
      <Text color={theme.textSubtle}>{footer}</Text>
    ) : (
      footer
    )
  ) : null;
  return (
    <Box flexDirection="column" width="100%">
      <Card
        color={color}
        title={
          title ? (
            <Text color={theme.textMuted} bold wrap="truncate-end">
              {title}
            </Text>
          ) : undefined
        }
      >
        {children}
        {footerPlacement === 'inside' && footerNode && <Box marginTop={1}>{footerNode}</Box>}
      </Card>
      {footerPlacement === 'outside' && footerNode}
    </Box>
  );
};
