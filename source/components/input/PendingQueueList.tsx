import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import type { UserTurn } from '../../types/user-turn.js';
import { MenuFooter, SelectionMarker } from '../common/MenuContainer.js';
import { type ColorRole, useTheme } from '../theme.js';

export type PendingQueueDelivery = 'steer' | 'follow_up';

export type PendingQueueMessage = {
  id: string;
  text: string;
  /** Editable payload, distinct from the rendered attachment summary. */
  turn: UserTurn;
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

// Group colors match the Enter Steer / Alt+Enter Queue hints under the input.
const GROUPS: ReadonlyArray<{ delivery: PendingQueueDelivery; label: string; timing: string; tone: ColorRole }> = [
  { delivery: 'steer', label: 'steer', timing: 'mid-turn', tone: 'accent' },
  { delivery: 'follow_up', label: 'queued', timing: 'after this turn', tone: 'accentAlt' },
];

const SELECTING_HINTS: ReadonlyArray<[key: string, action: string]> = [
  ['↑↓', 'navigate'],
  ['e', 'edit'],
  ['d', 'delete'],
  ['Esc', 'back'],
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
  const theme = useTheme();
  const selecting = selectedIndex !== null;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={selecting ? theme.borderActive : theme.border}
      paddingLeft={1}
    >
      {GROUPS.map((group) => {
        const rows = messages
          .map((message, index) => ({ message, index }))
          .filter(({ message }) => message.delivery === group.delivery);
        if (rows.length === 0) return null;
        return (
          <Box key={group.delivery} flexDirection="column">
            <Text color={theme.textSubtle}>
              <Text color={theme[group.tone]}>{group.label}</Text> · {group.timing}
            </Text>
            {rows.map(({ message, index }) => {
              const selected = index === selectedIndex;
              const editing = message.id === editingId;
              return (
                <Box key={message.id} flexDirection="row">
                  <SelectionMarker selected={selected} />
                  <Text
                    color={selected ? theme.text : theme.textMuted}
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
      {notice ? <Text color={theme.warning}>{notice}</Text> : selecting && <MenuFooter hints={SELECTING_HINTS} />}
    </Box>
  );
};

export default PendingQueueList;
