import React, { type FC } from 'react';
import { Box, Text, useStdout } from 'ink';
import { GLYPH_SELECTED, GLYPH_WARNING, useTheme } from '../../components/theme.js';
import type { ApprovalChoicesProps, ApprovalFrameProps } from '../types.js';
import { Chip } from './chip.js';

/** Below this width the options stack, one per row, instead of wrapping as a chip row. */
export const APPROVAL_VERTICAL_BELOW_COLUMNS = 60;

/**
 * A bar row that names the class of request, then the container's title. A caution is
 * an `APPROVAL` chip over a plain rule; a danger is a different word, a `▲`, and a
 * heavier rule, so the two differ in shape and not only in colour. The request itself
 * (command, diff, advisory, choices) sits beneath, against a rule in the tone's colour.
 */
export const LedgerApprovalFrame: FC<ApprovalFrameProps> = ({ tone, header, subheader, children }) => {
  const theme = useTheme();
  const danger = tone === 'danger';
  const toneRole = danger ? 'danger' : 'warning';
  return (
    <Box flexDirection="column">
      <Box width="100%" backgroundColor={theme.codeBackground}>
        <Box flexShrink={0}>
          <Chip solid tone={toneRole}>
            {danger ? `${GLYPH_WARNING} DANGER` : 'APPROVAL'}
          </Chip>
        </Box>
        <Box marginLeft={1} flexShrink={1}>
          <Text bold color={danger ? theme.danger : theme.text}>
            {header}
          </Text>
        </Box>
      </Box>
      {subheader}
      <Box
        flexDirection="column"
        borderStyle={danger ? 'bold' : 'single'}
        borderTop={false}
        borderBottom={false}
        borderRight={false}
        borderColor={theme[toneRole]}
        paddingLeft={1}
      >
        {children}
      </Box>
    </Box>
  );
};

const OptionChip: FC<{
  index: number;
  label: string;
  tone: ApprovalChoicesProps['options'][number]['tone'];
  selected: boolean;
}> = ({ index, label, tone, selected }) => {
  const theme = useTheme();
  // Selection is a filled chip with a leading `❯`: the glyph is what survives `mono`
  // terminals that ignore reverse video, the fill is what the eye finds first.
  if (selected) {
    return (
      <Chip solid tone={tone}>
        {GLYPH_SELECTED} {index + 1} {label}
      </Chip>
    );
  }
  return (
    <Chip tone="textMuted">
      <Text bold color={theme[tone]}>
        {index + 1}
      </Text>{' '}
      {label}
    </Chip>
  );
};

/**
 * The question, then the options as numbered chips on one wrapping row (a column when
 * narrow), then what the selected option does as one dim line.
 */
export const LedgerApprovalChoices: FC<ApprovalChoicesProps> = ({
  question,
  options,
  selectedIndex,
  layout,
  description,
}) => {
  const theme = useTheme();
  const { stdout } = useStdout();
  const vertical = (stdout.columns ?? 100) < APPROVAL_VERTICAL_BELOW_COLUMNS;
  const selectedLabel = options[selectedIndex]?.label;
  const showDescription = layout === 'two-pane' && description !== undefined;

  return (
    <Box flexDirection="column" marginTop={1}>
      {question !== undefined && (
        <Text bold color={theme.text}>
          {question}
        </Text>
      )}
      <Box flexDirection={vertical ? 'column' : 'row'} flexWrap={vertical ? 'nowrap' : 'wrap'} columnGap={1}>
        {options.map((option, index) => (
          <Box key={`${index}-${option.label}`} alignSelf="flex-start">
            <OptionChip index={index} label={option.label} tone={option.tone} selected={index === selectedIndex} />
          </Box>
        ))}
      </Box>
      {showDescription && description.text !== undefined && description.text !== '' && (
        <Box>
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.textSubtle}>↳</Text>
          </Box>
          <Box flexShrink={1}>
            <Text color={theme.textSubtle}>
              {description.title !== selectedLabel ? <Text bold>{description.title}: </Text> : null}
              {description.text}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};
