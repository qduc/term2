import React, { type FC, type ReactNode } from 'react';
import { Box, Text, useStdout } from 'ink';
import { SelectionMarker } from '../../components/common/SelectionMarker.js';
import { useTheme } from '../../components/theme.js';
import type { ApprovalChoicesProps, ApprovalFrameProps } from '../types.js';

/**
 * Left: the options. Right: what the selected one does. Below 90 columns the
 * description drops underneath instead of beside the list. Exported because the
 * ask-user prompt, which skins do not yet restyle, shares it.
 */
export const TwoPaneApprovalLayout: FC<{
  left: ReactNode;
  rightTitle: ReactNode;
  rightDescription: ReactNode;
}> = ({ left, rightTitle, rightDescription }) => {
  const theme = useTheme();
  const { stdout } = useStdout();
  const isNarrow = (stdout.columns ?? 100) < 90;
  const description = (
    <Box
      flexDirection="column"
      width={isNarrow ? '100%' : '50%'}
      paddingLeft={isNarrow ? 0 : 2}
      marginTop={isNarrow ? 1 : 0}
      borderStyle={isNarrow ? undefined : 'single'}
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      borderLeft={!isNarrow}
      borderColor={theme.border}
    >
      <Text bold color={theme.warning}>
        {rightTitle}
      </Text>
      <Box marginTop={1}>
        {rightDescription ? (
          <Text color={theme.text}>{rightDescription}</Text>
        ) : (
          <Text color={theme.textSubtle} italic>
            No description available.
          </Text>
        )}
      </Box>
    </Box>
  );
  return (
    <Box flexDirection={isNarrow ? 'column' : 'row'} width="100%" marginTop={1}>
      <Box flexDirection="column" width={isNarrow ? '100%' : '50%'} flexShrink={0} flexGrow={0}>
        {left}
      </Box>
      {description}
    </Box>
  );
};

/**
 * A title line, then the request. The riskiest class gets a red left border, not
 * just red text, so it is recognisable by shape before the words are read.
 */
export const ClassicApprovalFrame: FC<ApprovalFrameProps> = ({ tone, header, subheader, children }) => {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.warning}>{header}</Text>
      {subheader}
      {tone === 'danger' ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderLeft={true}
          borderColor={theme.danger}
          paddingLeft={1}
          marginTop={1}
        >
          {children}
        </Box>
      ) : (
        children
      )}
    </Box>
  );
};

export const ClassicApprovalChoices: FC<ApprovalChoicesProps> = ({
  question,
  options,
  selectedIndex,
  layout,
  description,
}) => {
  const theme = useTheme();
  const rows = options.map((option, index) => {
    const isSelected = selectedIndex === index;
    return (
      <Box key={option.label}>
        <SelectionMarker selected={isSelected} />
        <Text color={isSelected ? theme[option.tone] : undefined}>
          {index + 1}. {option.label}
        </Text>
      </Box>
    );
  });

  if (layout === 'list') {
    return <>{rows}</>;
  }

  return (
    <>
      {question !== undefined && <Text>{question}</Text>}
      <TwoPaneApprovalLayout
        left={rows}
        rightTitle={description?.title ?? 'Option'}
        rightDescription={description?.text}
      />
    </>
  );
};
