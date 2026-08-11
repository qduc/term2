import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer } from '../common/MenuContainer.js';
import {
  formatMentorPoolProvider,
  formatMentorPoolReasoning,
  type MentorPoolDraft,
  type MentorPoolMenuItem,
  type MentorPoolPhase,
} from '../../hooks/use-mentor-pool-selection.js';

type Props = {
  phase: MentorPoolPhase;
  selectedIndex: number;
  activeItems: MentorPoolMenuItem[];
  draft: MentorPoolDraft | null;
  errorMessage: string | null;
  fieldErrors: Record<string, string>;
};

export function MentorPoolSelectionMenu({
  phase,
  selectedIndex,
  activeItems,
  draft,
  errorMessage,
  fieldErrors,
}: Props) {
  const title =
    phase === 'list'
      ? 'Mentor Pool'
      : phase === 'edit_fields'
      ? draft?._isNew
        ? 'Add Mentor Entry'
        : 'Edit Mentor Entry'
      : phase === 'edit_model'
      ? 'Enter Model ID'
      : phase === 'edit_provider'
      ? 'Select Provider'
      : phase === 'edit_reasoning'
      ? 'Select Reasoning Effort'
      : phase === 'reorder'
      ? 'Reorder Mentor Entries'
      : phase === 'confirm_delete'
      ? 'Delete Mentor Entry?'
      : 'Discard Changes?';

  if (phase === 'edit_model') {
    return (
      <Box borderStyle="round" borderColor={errorMessage ? 'red' : 'cyan'} paddingX={1} flexDirection="column">
        <Text color="cyan" bold underline>
          {title}
        </Text>
        <Text color="gray">Type the model ID below and press Enter.</Text>
        <Text color="yellow">Current value: {draft?.model || '<empty>'}</Text>
        {errorMessage && <Text color="red">⚠ {errorMessage}</Text>}
        <Text color="gray" dimColor>
          Esc → go back
        </Text>
      </Box>
    );
  }

  const footer =
    phase === 'list'
      ? 'Enter → select · Del → delete · Esc → save & close · ↑↓ → navigate'
      : phase === 'edit_fields'
      ? 'Enter → edit field / save · Esc → cancel · ↑↓ → navigate'
      : phase === 'reorder'
      ? '[ / ] → move · Enter → save order · Esc → cancel'
      : 'Enter → select · Esc → go back · ↑↓ → navigate';

  const entryCount = activeItems.filter((item) => item.kind === 'entry').length;
  const isListEmpty = phase === 'list' && entryCount === 0;

  return (
    <Box flexDirection="column">
      <Text color={phase === 'confirm_delete' ? 'red' : 'cyan'} bold underline>
        {title}
      </Text>
      {phase === 'list' && (
        <Box flexDirection="column">
          <Text color="gray">Each entry gets one independent answer for each question.</Text>
          <Text color="#64748b">{entryCount}/8 entries · A configured pool overrides mentor samples.</Text>
          {isListEmpty && <Text color="#64748b">No mentor entries configured yet. Add one to get started.</Text>}
        </Box>
      )}
      {phase === 'confirm_delete' && <Text color="red">⚠ This entry will be removed from the pool.</Text>}
      {phase === 'confirm_discard' && <Text color="yellow">⚠ You have unsaved changes. Discard them?</Text>}
      {errorMessage && <Text color="red">⚠ {errorMessage}</Text>}
      <MenuContainer
        items={activeItems}
        selectedIndex={selectedIndex}
        borderColor={phase === 'confirm_delete' || phase === 'confirm_discard' || errorMessage ? 'red' : 'cyan'}
        footer={footer}
        renderItem={(item, index, selected, inactive) => {
          let label = item.label;
          let prefix = selected ? '▶ ' : '  ';
          let color = selected ? 'green' : 'white';
          if (item.kind === 'action') {
            prefix =
              item.action === 'add' ? '+ ' : item.action === 'reorder' ? '↕ ' : item.action === 'save' ? '✓ ' : prefix;
            color =
              item.tone === 'destructive' ? 'red' : item.action === 'add' ? 'yellow' : selected ? 'green' : 'white';
          } else if (item.kind === 'field') {
            label = `${item.label}: ${item.detail}`;
            color = selected ? 'green' : 'white';
          } else if (item.kind === 'entry' || item.kind === 'reorder-entry') {
            label = `${item.index + 1}. ${item.entry.model}`;
          } else if (item.kind === 'provider' || item.kind === 'reasoning') {
            color = selected ? 'green' : 'white';
          }
          if (inactive) color = 'gray';
          const field = item.kind === 'field' ? fieldErrors[item.field] : undefined;
          return (
            <Box key={`${item.kind}-${index}-${label}`} flexDirection="column">
              <Box flexDirection="row">
                <Text color={color} bold={selected || (item.kind === 'action' && item.tone === 'destructive')}>
                  {prefix}
                  {label}
                </Text>
                {item.kind === 'entry' || item.kind === 'reorder-entry' ? (
                  <Text color={selected ? 'white' : '#64748b'}>
                    {'  '}· Provider: {formatMentorPoolProvider(item.entry.provider)} · Reasoning:{' '}
                    {formatMentorPoolReasoning(item.entry.reasoningEffort)}
                  </Text>
                ) : null}
              </Box>
              {field && <Text color="red"> ⚠ {field}</Text>}
            </Box>
          );
        }}
      />
    </Box>
  );
}

export default MentorPoolSelectionMenu;
