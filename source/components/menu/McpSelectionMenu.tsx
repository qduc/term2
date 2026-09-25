import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer } from '../common/MenuContainer.js';
import {
  GLYPH_WARNING,
  COLOR_ACCENT,
  COLOR_DANGER,
  COLOR_SUCCESS,
  COLOR_TEXT,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
} from '../theme.js';

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
  return (
    <Box flexDirection="column">
      <Text color={COLOR_ACCENT} bold underline>
        {title}
      </Text>
      {error ? (
        <Text color={COLOR_DANGER}>
          {GLYPH_WARNING} {error}
        </Text>
      ) : null}
      {editing ? <Text color={COLOR_TEXT_SUBTLE}>Enter a value below. Escape cancels.</Text> : null}
      {!editing ? (
        <MenuContainer
          items={[...items]}
          selectedIndex={selectedIndex}
          borderColor={error ? COLOR_DANGER : COLOR_ACCENT}
          footer="Enter → Select · ↑↓ → Navigate · Esc → Back"
          renderItem={(item, index, selected) => (
            <Box key={item.id}>
              <Text color={selected ? COLOR_SUCCESS : COLOR_TEXT_SUBTLE}>{selected ? '▶ ' : '  '}</Text>
              <Text
                bold={selected}
                color={item.tone === 'danger' ? COLOR_DANGER : item.tone === 'warning' ? COLOR_WARNING : COLOR_TEXT}
              >
                {item.label}
              </Text>
              {item.detail ? <Text color={COLOR_TEXT_SUBTLE}> {item.detail}</Text> : null}
            </Box>
          )}
        />
      ) : null}
    </Box>
  );
}
