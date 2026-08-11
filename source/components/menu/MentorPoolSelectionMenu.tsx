import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer } from '../common/MenuContainer.js';
import type { MentorPoolDraft, MentorPoolMenuItem, MentorPoolPhase } from '../../hooks/use-mentor-pool-selection.js';

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
      ? 'Edit Mentor Entry'
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
        <Text color="gray">Type a model ID and press Enter.</Text>
        {draft?.model && <Text color="yellow">Current value: {draft.model}</Text>}
        {errorMessage && <Text color="red">⚠ {errorMessage}</Text>}
      </Box>
    );
  }

  const footer =
    phase === 'list'
      ? 'Enter edit · Del remove · Esc save and back · ↑↓ navigate'
      : phase === 'edit_fields'
      ? 'Enter edit field or save · Esc cancel · ↑↓ navigate'
      : phase === 'reorder'
      ? '[ / ] move · Enter save order · Esc cancel'
      : phase === 'confirm_delete' || phase === 'confirm_discard'
      ? 'Enter select · Esc go back · ↑↓ navigate'
      : 'Enter select · Esc go back · ↑↓ navigate';

  return (
    <Box flexDirection="column">
      <Text color={phase === 'confirm_delete' ? 'red' : 'cyan'} bold underline>
        {title}
      </Text>
      {phase === 'confirm_delete' && <Text color="red">⚠ This entry will be removed from the pool.</Text>}
      {phase === 'confirm_discard' && <Text color="yellow">⚠ You have unsaved changes. Discard them?</Text>}
      {errorMessage && <Text color="red">⚠ {errorMessage}</Text>}
      <MenuContainer
        items={activeItems}
        selectedIndex={selectedIndex}
        borderColor={phase === 'confirm_delete' || phase === 'confirm_discard' || errorMessage ? 'red' : 'cyan'}
        footer={footer}
        renderItem={(item, _index, selected, inactive) => {
          let label = item.label;
          let prefix = selected ? '▶ ' : '  ';
          let color = selected ? 'green' : 'white';
          if (item.kind === 'action') {
            prefix = item.action === 'add' ? '+ ' : prefix;
            color = item.tone === 'destructive' ? 'red' : selected ? 'green' : 'white';
          } else if (item.kind === 'field') {
            label = `${item.label}: ${item.detail}`;
            color = selected ? 'green' : 'white';
          } else if (item.kind === 'reorder-entry') {
            label = `${item.label} ${selected ? '↕' : ''}`;
          } else if (item.kind === 'provider' || item.kind === 'reasoning') {
            color = selected ? 'green' : 'white';
          }
          if (inactive) color = 'gray';
          const field = item.kind === 'field' ? fieldErrors[item.field] : undefined;
          return (
            <Box key={`${item.kind}-${label}`} flexDirection="column">
              <Text color={color} bold={selected || (item.kind === 'action' && item.tone === 'destructive')}>
                {prefix}
                {label}
              </Text>
              {field && <Text color="red"> ⚠ {field}</Text>}
            </Box>
          );
        }}
      />
    </Box>
  );
}

export default MentorPoolSelectionMenu;
