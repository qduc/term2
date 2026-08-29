import React, { type FC } from 'react';
import { Box, Text } from 'ink';
import {
  COLOR_ACCENT,
  COLOR_DANGER_SOFT,
  COLOR_TEXT,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SUBTLE,
  COLOR_WARNING,
} from '../theme.js';

export type PendingQueueMessage = { id: string; text: string; queuedAt: number };

type Props = {
  messages: ReadonlyArray<PendingQueueMessage>;
  selectedIndex: number | null;
  editingId: string | null;
  notice: string | null;
};

/**
 * The visible half of InputBox's local queued-submission selection mode.
 * Keyboard ownership stays in InputBox so this inline surface does not need a
 * new application-wide InputOwner variant.
 */
const PendingQueueList: FC<Props> = ({ messages, selectedIndex, editingId, notice }) => (
  <Box flexDirection="column" marginTop={1} marginBottom={1}>
    {messages.map((message, index) => {
      const selected = index === selectedIndex;
      const editing = message.id === editingId;
      const preview = selected || editing || message.text.length <= 80 ? message.text : `${message.text.slice(0, 80)}…`;
      return (
        <Box key={message.id} flexDirection="row">
          <Text color={selected ? COLOR_ACCENT : COLOR_TEXT_MUTED} bold={selected}>
            {selected ? '> ' : '  '}⏳ Queued {index + 1}.{' '}
          </Text>
          <Text color={selected ? COLOR_TEXT : COLOR_TEXT_MUTED} bold={selected} dimColor={editing}>
            {preview}
          </Text>
          {selected && (
            <Text color={COLOR_TEXT_SUBTLE}>
              {' '}
              [<Text color={COLOR_ACCENT}>e</Text>]dit [<Text color={COLOR_DANGER_SOFT}>d</Text>]elete
            </Text>
          )}
        </Box>
      );
    })}
    {selectedIndex !== null && (
      <Box marginTop={0}>
        <Text color={COLOR_TEXT_SUBTLE}>
          <Text color={COLOR_TEXT_MUTED}>↑↓</Text> select · <Text color={COLOR_TEXT_MUTED}>e</Text> edit ·{' '}
          <Text color={COLOR_TEXT_MUTED}>d</Text> delete · <Text color={COLOR_TEXT_MUTED}>esc</Text> back to input
        </Text>
      </Box>
    )}
    {notice && (
      <Box marginTop={0}>
        <Text color={COLOR_WARNING}>{notice}</Text>
      </Box>
    )}
  </Box>
);

export default PendingQueueList;
