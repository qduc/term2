import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_SELECTED, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import type { ApprovalChoicesProps, ApprovalFrameProps } from '../types.js';
import { RAIL_HEAVY, RAIL_SOLID, Rail } from './parts.js';

/**
 * A rail down the whole height of the request, in place of a box. The two classes
 * differ in shape as well as colour, so they are told apart in `mono` and by a
 * glance: caution is a half-block rail under a plain title; danger is a solid
 * block rail under a title that begins with `▲`.
 */
export const RailApprovalFrame: FC<ApprovalFrameProps> = ({ tone, header, subheader, children }) => {
  const theme = useTheme();
  const danger = tone === 'danger';
  return (
    <Rail glyph={danger ? RAIL_SOLID : RAIL_HEAVY} color={danger ? theme.danger : theme.warning}>
      <Text bold color={danger ? theme.danger : undefined}>
        {danger ? `${GLYPH_WARNING} ` : ''}
        {header}
      </Text>
      {subheader}
      {children}
    </Rail>
  );
};

/**
 * The question, then a numbered list with the selected row in its tone, then the
 * selected option's description as one dim line, in place of a side pane. The
 * list-only layout (no description to show) is the same list without the line.
 */
export const RailApprovalChoices: FC<ApprovalChoicesProps> = ({
  question,
  options,
  selectedIndex,
  layout,
  description,
}) => {
  const theme = useTheme();
  const note = layout === 'two-pane' ? description?.text : undefined;
  return (
    <Box flexDirection="column">
      {layout === 'two-pane' && question !== undefined && <Text bold>{question}</Text>}
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const tone = theme[option.tone];
        return (
          <Box key={option.label}>
            <Box width={2} flexShrink={0}>
              <Text color={theme.accent} bold>
                {selected ? GLYPH_SELECTED : ' '}
              </Text>
            </Box>
            <Box width={2} flexShrink={0}>
              <Text color={selected ? tone : theme.textSubtle} bold={selected}>
                {index + 1}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Text color={selected ? tone : theme.textMuted} bold={selected}>
                {option.label}
              </Text>
            </Box>
          </Box>
        );
      })}
      {note && (
        <Box marginLeft={4}>
          <Text color={theme.textSubtle} italic>
            {note}
          </Text>
        </Box>
      )}
    </Box>
  );
};
