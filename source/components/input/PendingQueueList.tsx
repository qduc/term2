import React, { type FC } from 'react';
import { Box, Text } from 'ink';

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
          <Text color={selected ? '#22d3ee' : '#94a3b8'}>
            {selected ? '> ' : '  '}⏳ Queued {index + 1}.{' '}
          </Text>
          <Text color="#cbd5e1" dimColor={editing}>
            {preview}
          </Text>
          {selected && <Text color="#64748b"> [e]dit [d]elete</Text>}
        </Box>
      );
    })}
    {selectedIndex !== null && <Text color="#64748b">↑↓ select · e edit · d delete · esc back to input</Text>}
    {notice && <Text color="#fbbf24">{notice}</Text>}
  </Box>
);

export default PendingQueueList;
