import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer, MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { GLYPH_WARNING, useTheme } from '../theme.js';

export interface McpMenuItem {
  id: string;
  label: string;
  detail?: string;
  tone?: 'normal' | 'warning' | 'danger';
}

export function McpSelectionMenu({
  title,
  items,
  selectedIndex,
  error,
  editing,
}: {
  title: string;
  items: readonly McpMenuItem[];
  selectedIndex: number;
  error?: string;
  editing?: boolean;
}) {
  const theme = useTheme();
  return (
    <Box flexDirection="column">
      <Text color={theme.accent} bold underline>
        {title}
      </Text>
      {error ? (
        <Text color={theme.danger}>
          {GLYPH_WARNING} {error}
        </Text>
      ) : null}
      {editing ? <Text color={theme.textSubtle}>Enter a value below. Esc cancels.</Text> : null}
      {!editing ? (
        <MenuContainer
          items={[...items]}
          selectedIndex={selectedIndex}
          borderColor={error ? theme.danger : theme.accent}
          footer={
            <MenuFooter
              hints={[
                ['↑↓', 'navigate'],
                ['⏎', 'select'],
                ['Esc', 'back'],
              ]}
            />
          }
          renderItem={(item, index, selected) => (
            <Box key={item.id}>
              <SelectionMarker selected={selected} />
              <Text
                bold={selected}
                color={item.tone === 'danger' ? theme.danger : item.tone === 'warning' ? theme.warning : theme.text}
              >
                {item.label}
              </Text>
              {item.detail ? <Text color={theme.textSubtle}> {item.detail}</Text> : null}
            </Box>
          )}
        />
      ) : null}
    </Box>
  );
}
