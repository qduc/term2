import React, { FC } from 'react';
import { Box, Text } from 'ink';
import type { CopySelection } from '../../utils/copy-selections.js';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { useTheme } from '../theme.js';

type Props = {
  items: CopySelection[];
  selectedIndex: number;
};

export function getCodePreview(text: string, maxLength = 60): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

const CopyMenu: FC<Props> = ({ items, selectedIndex }) => {
  const theme = useTheme();
  return (
    <MenuContainer
      items={items}
      selectedIndex={selectedIndex}
      borderColor={theme.accent}
      footer={
        <MenuFooter
          hints={[
            ['↑↓', 'navigate'],
            ['⏎', 'copy'],
            ['Esc', 'cancel'],
          ]}
        />
      }
      renderItem={(item, index, isSelected) => {
        const isCodeBlock = item.label !== 'Full response';
        const preview = isCodeBlock ? getCodePreview(item.text) : '';

        return (
          <Box key={`${item.label}-${index}`}>
            <SelectionMarker selected={isSelected} />
            <Text color={isSelected ? theme.accent : undefined} bold={isSelected}>
              {`${index + 1}. ${item.label}`}
            </Text>
            {preview ? (
              <Text color={isSelected ? theme.accent : theme.textSubtle} dimColor={!isSelected}>
                {` — ${preview}`}
              </Text>
            ) : null}
          </Box>
        );
      }}
    />
  );
};

export default CopyMenu;
