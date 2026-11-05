import React from 'react';
import { Box, Text } from 'ink';
import { useSkin } from './presentation/skins/SkinContext.js';
import { useTheme } from './presentation/components/theme.js';
import { SelectionMarker } from './presentation/components/common/SelectionMarker.js';
import type { QueueItem } from './state.js';

/** Inline queue display, matching the legacy pending queue groups above the composer. */
export function PendingQueue({
  items,
  selectedId,
  editingId,
  notice,
}: {
  items: readonly QueueItem[];
  selectedId: string | null;
  editingId: string | null;
  notice: string | null;
}): React.ReactElement | null {
  const theme = useTheme();
  const { Hints } = useSkin();
  if (!items.length) return null;
  const groups = [
    { delivery: 'steering', label: 'steer', timing: 'mid-turn', color: theme.accent },
    { delivery: 'queued', label: 'queued', timing: 'after this turn', color: theme.accentAlt },
  ];
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={selectedId ? theme.borderActive : theme.border}
      paddingLeft={1}
    >
      {groups.map((group) => {
        const rows = items.filter((item) => item.delivery === group.delivery);
        if (!rows.length) return null;
        return (
          <Box key={group.delivery} flexDirection="column">
            <Text color={theme.textSubtle}>
              <Text color={group.color}>{group.label}</Text> · {group.timing}
            </Text>
            {rows.map((item) => (
              <Box key={item.id} flexDirection="row">
                <SelectionMarker selected={item.id === selectedId} />
                <Text
                  color={item.id === selectedId ? theme.text : theme.textMuted}
                  bold={item.id === selectedId}
                  dimColor={item.id === editingId}
                  wrap={item.id === selectedId || item.id === editingId ? 'wrap' : 'truncate-end'}
                >
                  {item.displayText ?? item.text}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
      {notice ? (
        <Text color={theme.warning}>{notice}</Text>
      ) : selectedId ? (
        <Hints
          hints={[
            ['↑↓', 'navigate'],
            ['e', 'edit'],
            ['d', 'delete'],
            ['Esc', 'back'],
          ]}
        />
      ) : null}
    </Box>
  );
}

/** Label the queue item currently being edited above the composer. */
export function PendingQueueEdit({
  editingId,
  items,
}: {
  editingId: string | null;
  items: readonly QueueItem[];
}): React.ReactElement | null {
  const theme = useTheme();
  if (!editingId) return null;
  return (
    <Box>
      <Text color={theme.accent}>
        edit {items.find((item) => item.id === editingId)?.delivery === 'steering' ? 'steer' : 'queued'} ▸{' '}
      </Text>
    </Box>
  );
}
