import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../components/theme.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
import type { ApprovalChoicesProps, ApprovalFrameProps } from '../types.js';
import { MARKER_COLUMNS, useZenStyles } from './style.js';
import { cells } from './width.js';

const SELECTED_MARKER = '›';
const OPTION_SEPARATOR = '  ·  ';

/**
 * No box and no rail: an interruption is a sentence, then a blank line, then the
 * thing being asked about, indented under it. Zen has no chrome to make the
 * riskiest class loud, so that class is told apart by shape: a `▲` ahead of the
 * sentence and a heavy `┃` rule down the left of everything it covers. Both survive
 * a terminal with no colour.
 */
export const ZenApprovalFrame: FC<ApprovalFrameProps> = ({ tone, header, subheader, children }) => {
  const theme = useTheme();
  const { colourless } = useZenStyles();
  const danger = tone === 'danger';
  return (
    <Box flexDirection="column">
      <Box>
        {danger && (
          <Box width={MARKER_COLUMNS} flexShrink={0}>
            <Text color={theme.danger} bold>
              ▲
            </Text>
          </Box>
        )}
        <Text color={danger ? theme.danger : theme.warning} bold={danger && colourless}>
          {header}
        </Text>
      </Box>
      {/* The one danger subheader today (a blocked path) arrives with its own leading space. */}
      {subheader !== undefined && subheader !== null && (
        <Box paddingLeft={danger ? MARKER_COLUMNS - 1 : MARKER_COLUMNS}>{subheader}</Box>
      )}
      {danger ? (
        <Box
          flexDirection="column"
          borderStyle="bold"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={theme.danger}
          paddingLeft={1}
        >
          {children}
        </Box>
      ) : (
        <Box flexDirection="column" paddingLeft={MARKER_COLUMNS}>
          {children}
        </Box>
      )}
    </Box>
  );
};

/**
 * The question as a sentence, then the answers on one line, `1 Allow once  ·  2 Deny`,
 * with the number keys visible. The selected answer is bold, in its own tone, and
 * carries a `›`. When the answers do not fit on one line (a narrow terminal, or a
 * menu of four long labels) they stack, one per row, with the same markers. The
 * selected answer's explanation is one dim line beneath, so choosing never needs a
 * second pane.
 */
export const ZenApprovalChoices: FC<ApprovalChoicesProps> = ({
  question,
  options,
  selectedIndex,
  layout,
  description,
}) => {
  const theme = useTheme();
  const { faint, quiet } = useZenStyles();
  const columns = useTerminalColumns();

  // The frame indents its body, and the options sit inside it.
  const available = Math.max(1, columns - MARKER_COLUMNS - 2);
  const inlineWidth =
    options.reduce((total, option, index) => total + cells(`${index + 1} ${option.label}`), 0) +
    cells(OPTION_SEPARATOR) * Math.max(0, options.length - 1) +
    cells(`${SELECTED_MARKER} `);
  const inline = layout === 'two-pane' && inlineWidth <= available;

  const label = (option: ApprovalChoicesProps['options'][number], index: number) => {
    const selected = index === selectedIndex;
    return (
      <Text color={selected ? theme[option.tone] : undefined} bold={selected}>
        <Text {...(selected ? { color: theme[option.tone] } : faint)}>{index + 1}</Text> {option.label}
      </Text>
    );
  };

  const explanation =
    layout === 'two-pane' && description?.text ? (
      <Box paddingLeft={inline ? MARKER_COLUMNS : MARKER_COLUMNS * 2}>
        <Text {...quiet}>{description.text}</Text>
      </Box>
    ) : null;

  return (
    <>
      {question !== undefined && <Text>{question}</Text>}
      {inline ? (
        <Box>
          {options.map((option, index) => (
            <React.Fragment key={option.label}>
              {index > 0 && <Text {...faint}>{OPTION_SEPARATOR}</Text>}
              {index === selectedIndex && (
                <Text color={theme[option.tone]} bold>
                  {SELECTED_MARKER}{' '}
                </Text>
              )}
              {label(option, index)}
            </React.Fragment>
          ))}
        </Box>
      ) : (
        options.map((option, index) => (
          <Box key={option.label}>
            <Box width={MARKER_COLUMNS} flexShrink={0}>
              {index === selectedIndex && (
                <Text color={theme[option.tone]} bold>
                  {SELECTED_MARKER}
                </Text>
              )}
            </Box>
            {label(option, index)}
          </Box>
        ))
      )}
      {explanation}
    </>
  );
};
