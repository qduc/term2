import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import {
  COLOR_ACCENT,
  COLOR_ACCENT_ALT,
  COLOR_BORDER,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
} from '../theme.js';

export type PendingQueueDelivery = 'steer' | 'follow_up';

export type PendingQueueMessage = {
  id: string;
  text: string;
  queuedAt: number;
  delivery: PendingQueueDelivery;
};

type Props = {
  /** Must already be in display order; see orderPendingQueueMessages. */
  messages: ReadonlyArray<PendingQueueMessage>;
  selectedIndex: number | null;
  editingId: string | null;
  notice: string | null;
};

const GROUPS: ReadonlyArray<{ delivery: PendingQueueDelivery; label: string; timing: string; color: string }> = [
  { delivery: 'steer', label: 'steer', timing: 'mid-turn', color: COLOR_WARNING },
  { delivery: 'follow_up', label: 'queued', timing: 'after this turn', color: COLOR_ACCENT_ALT },
];

/**
 * Steers are delivered before follow-ups, so grouping them first keeps the
 * list in delivery order. InputBox indexes its selection into this order.
 */
export const orderPendingQueueMessages = (
  messages: ReadonlyArray<PendingQueueMessage>,
): ReadonlyArray<PendingQueueMessage> =>
  GROUPS.flatMap(({ delivery }) => messages.filter((m) => m.delivery === delivery));

/**
 * The visible half of InputBox's local queued-submission selection mode.
 * Keyboard ownership stays in InputBox so this inline surface does not need a
 * new application-wide InputOwner variant.
 */
const PendingQueueList: FC<Props> = ({ messages, selectedIndex, editingId, notice }) => {
  const selecting = selectedIndex !== null;
  const hasSteer = messages.some((message) => message.delivery === 'steer');
  const borderColor = selecting ? COLOR_ACCENT : hasSteer ? COLOR_WARNING : COLOR_BORDER;

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={borderColor}
      paddingLeft={1}
    >
      {GROUPS.map((group) => {
        const rows = messages
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => message.delivery === group.delivery);
        if (rows.length === 0) return null;
        return (
          <Box key={group.delivery} flexDirection="column">
            <Text color={COLOR_TEXT_SUBTLE}>
              <Text color={group.color}>{group.label}</Text> · {group.timing}
            </Text>
            {rows.map(({ message, index }) => {
              const selected = index === selectedIndex;
              const editing = message.id === editingId;
              return (
                <Box key={message.id} flexDirection="row">
                  <Box flexShrink={0}>
                    <Text color={COLOR_ACCENT} bold>
                      {selected ? '▸ ' : '  '}
                    </Text>
                  </Box>
                  <Text
                    color={selected ? COLOR_TEXT : COLOR_TEXT_MUTED}
                    bold={selected}
                    dimColor={editing}
                    wrap={selected || editing ? 'wrap' : 'truncate-end'}
                  >
                    {message.text}
                  </Text>
                </Box>
              );
            })}
          </Box>
        );
      })}
      {notice ? (
        <Text color={COLOR_WARNING}>{notice}</Text>
      ) : (
        selecting && (
          <Text color={COLOR_TEXT_SUBTLE}>
            <Text color={COLOR_TEXT_MUTED}>↑↓</Text> move · <Text color={COLOR_TEXT_MUTED}>e</Text> edit ·{' '}
            <Text color={COLOR_TEXT_MUTED}>d</Text> delete · <Text color={COLOR_TEXT_MUTED}>esc</Text> done
          </Text>
        )
      )}
    </Box>
  );
};

export default PendingQueueList;
