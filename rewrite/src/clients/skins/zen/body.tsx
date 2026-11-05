import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, useTheme } from '../../components/theme.js';
import type { MenuFrameProps, QuestionPromptProps, SubagentFeedProps, ToolSectionProps } from '../types.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';

/**
 * A sentence, then the choices, indented under it: no box and no rail. The selected
 * row takes a `›` and is bold, which is what carries it in `mono`.
 */
export const ZenQuestionPrompt: FC<QuestionPromptProps> = ({
  progress,
  question,
  notice,
  options,
  description,
  footer,
}) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={MARKER_COLUMNS} flexShrink={0}>
          <Text color={theme.warning} bold>
            ?
          </Text>
        </Box>
        <Text bold>
          {question}
          {progress !== undefined && (
            <Text color={faint.color} dimColor={faint.dimColor} bold={false}>
              {'  '}({progress})
            </Text>
          )}
        </Text>
      </Box>
      {notice !== undefined && (
        <Box paddingLeft={MARKER_COLUMNS}>
          <Text color={theme.accent}>{notice}</Text>
        </Box>
      )}
      <Box flexDirection="column" paddingLeft={MARKER_COLUMNS} marginTop={1}>
        {options.map((option, index) => {
          const checkbox = option.checked === undefined ? '' : option.checked ? '[x] ' : '[ ] ';
          return (
            <Box key={option.label}>
              <Box width={2} flexShrink={0}>
                <Text color={theme.accent} bold>
                  {option.selected ? '›' : ' '}
                </Text>
              </Box>
              <Box flexShrink={1}>
                <Text color={option.selected && option.tone ? theme[option.tone] : undefined} bold={option.selected}>
                  {index + 1}. {checkbox}
                  {option.label}
                  {option.recommended ? ` ${GLYPH_FAVORITE}` : ''}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      {description.text && (
        <Box paddingLeft={MARKER_COLUMNS} marginTop={1}>
          <Text color={faint.color} dimColor={faint.dimColor} italic>
            {description.text}
          </Text>
        </Box>
      )}
      <Box paddingLeft={MARKER_COLUMNS} marginTop={1}>
        {footer}
      </Box>
    </Box>
  );
};

/** One quiet line for the task, its latest calls indented under it. Only a failure is coloured. */
export const ZenSubagentFeed: FC<SubagentFeedProps> = ({ title, statusSuffix, status, tone, summary, children }) => {
  const theme = useTheme();
  const { quiet, colourless } = useZenStyles();
  const failed = tone === 'danger';
  const glyph = failed ? '✗' : status === 'completed' ? '✓' : '↳';
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={MARKER_COLUMNS} flexShrink={0}>
          <Text color={failed ? theme.danger : quiet.color} dimColor={!failed && quiet.dimColor}>
            {glyph}
          </Text>
        </Box>
        <Text
          color={failed ? theme.danger : quiet.color}
          dimColor={!failed && quiet.dimColor}
          bold={failed && colourless}
        >
          {title}
          {statusSuffix}
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={MARKER_COLUMNS}>
        {summary !== undefined ? (
          <Text color={quiet.color} dimColor={quiet.dimColor}>
            {summary}
          </Text>
        ) : (
          children
        )}
      </Box>
    </Box>
  );
};

/** Everything is indent; a panel gets a quiet `│` margin and a callout a bold heading, with no boxes. */
export const ZenToolSection: FC<ToolSectionProps> = ({ variant, title, tone = 'warning', children }) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  if (variant === 'indent') {
    return (
      <Box flexDirection="column" paddingLeft={MARKER_COLUMNS}>
        {children}
      </Box>
    );
  }
  if (variant === 'panel') {
    return (
      <Box
        flexDirection="column"
        paddingLeft={1}
        marginLeft={MARKER_COLUMNS - 1}
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={faint.color}
        borderDimColor={faint.dimColor}
      >
        {children}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingLeft={MARKER_COLUMNS}>
      {title !== undefined && (
        <Text color={theme[tone]} bold>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
};

/** No border at all: a faint title, the rows, the hints. An error colours the title, not a frame. */
export const ZenMenuFrame: FC<MenuFrameProps> = ({ title, borderColor, footer, footerPlacement, children }) => {
  const theme = useTheme();
  const { faint } = useZenStyles();
  const footerNode = footer ? typeof footer === 'string' ? <Text color={faint.color}>{footer}</Text> : footer : null;
  const alarmed = borderColor === theme.danger;
  return (
    <Box flexDirection="column" width="100%">
      {title ? (
        <Text
          color={alarmed ? theme.danger : faint.color}
          dimColor={!alarmed && faint.dimColor}
          bold={alarmed && faint.dimColor}
        >
          {title}
        </Text>
      ) : null}
      {children}
      {footerNode && <Box marginTop={footerPlacement === 'inside' ? 1 : 0}>{footerNode}</Box>}
    </Box>
  );
};
