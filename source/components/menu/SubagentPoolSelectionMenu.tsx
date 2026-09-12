import React from 'react';
import { Box, Text } from 'ink';
import { MenuContainer } from '../common/MenuContainer.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';
import {
  formatSubagentPoolProvider,
  formatSubagentPoolReasoning,
  type SubagentPoolDraft,
  type SubagentPoolMenuItem,
  type SubagentPoolPhase,
} from '../../hooks/use-subagent-pool-selection.js';

type Props = {
  phase: SubagentPoolPhase;
  selectedIndex: number;
  activeItems: SubagentPoolMenuItem[];
  draft: SubagentPoolDraft | null;
  errorMessage: string | null;
  fieldErrors: Record<string, string>;
  /** Human label used in copy ("Mentor", "Explorer", ...). */
  roleLabel: string;
  /** Mentor fans a question out to every pool entry; other pools round-robin one entry per spawn. */
  poolKind: 'fanout' | 'round-robin';
  /** 'models' pools (tier model settings) render plain model rows without per-entry provider/reasoning. */
  entryShape: 'entries' | 'models';
};

export function SubagentPoolSelectionMenu({
  phase,
  selectedIndex,
  activeItems,
  draft,
  errorMessage,
  fieldErrors,
  roleLabel,
  poolKind,
  entryShape,
}: Props) {
  const title =
    phase === 'list'
      ? `${roleLabel} Pool`
      : phase === 'edit_fields'
      ? draft?._isNew
        ? `Add ${roleLabel} Entry`
        : `Edit ${roleLabel} Entry`
      : phase === 'edit_model'
      ? 'Enter Model ID'
      : phase === 'edit_provider'
      ? 'Select Provider'
      : phase === 'edit_reasoning'
      ? 'Select Reasoning Effort'
      : phase === 'reorder'
      ? `Reorder ${roleLabel} Entries`
      : phase === 'confirm_delete'
      ? `Delete ${roleLabel} Entry?`
      : 'Discard Changes?';

  if (phase === 'edit_model') {
    return (
      <Box
        borderStyle="round"
        borderColor={errorMessage ? COLOR_DANGER : COLOR_ACCENT}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={COLOR_ACCENT} bold underline>
          {title}
        </Text>
        <Text color={COLOR_TEXT_SUBTLE}>Type the model ID below and press Enter.</Text>
        <Text color={COLOR_WARNING}>Current value: {draft?.model || '<empty>'}</Text>
        {errorMessage && <Text color={COLOR_DANGER}>⚠ {errorMessage}</Text>}
        <Text color={COLOR_TEXT_SUBTLE} dimColor>
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
  const listSummary =
    poolKind === 'fanout'
      ? 'Each entry gets one independent answer for each question.'
      : entryShape === 'models'
      ? 'Subagent spawns use the next entry, round-robin; other tasks use the first entry.'
      : 'Each spawn uses the next entry, round-robin.';
  const listCountSuffix =
    poolKind === 'fanout'
      ? 'A configured pool overrides mentor samples.'
      : entryShape === 'models'
      ? 'A configured pool overrides the tier fallback.'
      : 'A configured pool overrides the role model.';

  return (
    <Box flexDirection="column">
      <Text color={phase === 'confirm_delete' ? COLOR_DANGER : COLOR_ACCENT} bold underline>
        {title}
      </Text>
      {phase === 'list' && (
        <Box flexDirection="column">
          <Text color={COLOR_TEXT_SUBTLE}>{listSummary}</Text>
          <Text color={COLOR_TEXT_SUBTLE}>
            {entryCount}/8 entries · {listCountSuffix}
          </Text>
          {isListEmpty && (
            <Text color={COLOR_TEXT_SUBTLE}>
              No {roleLabel.toLowerCase()} entries configured yet. Add one to get started.
            </Text>
          )}
        </Box>
      )}
      {phase === 'confirm_delete' && <Text color={COLOR_DANGER}>⚠ This entry will be removed from the pool.</Text>}
      {phase === 'confirm_discard' && <Text color={COLOR_WARNING}>⚠ You have unsaved changes. Discard them?</Text>}
      {errorMessage && <Text color={COLOR_DANGER}>⚠ {errorMessage}</Text>}
      <MenuContainer
        items={activeItems}
        selectedIndex={selectedIndex}
        borderColor={
          phase === 'confirm_delete' || phase === 'confirm_discard' || errorMessage ? COLOR_DANGER : COLOR_ACCENT
        }
        footer={footer}
        renderItem={(item, index, selected, inactive) => {
          let label = item.label;
          let prefix = selected ? '▶ ' : '  ';
          let color = selected ? COLOR_SUCCESS : COLOR_TEXT;
          if (item.kind === 'action') {
            prefix =
              item.action === 'add' ? '+ ' : item.action === 'reorder' ? '↕ ' : item.action === 'save' ? '✓ ' : prefix;
            color =
              item.tone === 'destructive'
                ? COLOR_DANGER
                : item.action === 'add'
                ? COLOR_WARNING
                : selected
                ? COLOR_SUCCESS
                : COLOR_TEXT;
          } else if (item.kind === 'field') {
            label = `${item.label}: ${item.detail}`;
            color = selected ? COLOR_SUCCESS : COLOR_TEXT;
          } else if (item.kind === 'entry' || item.kind === 'reorder-entry') {
            label = `${item.index + 1}. ${item.entry.model}`;
          } else if (item.kind === 'provider' || item.kind === 'reasoning') {
            color = selected ? COLOR_SUCCESS : COLOR_TEXT;
          }
          if (inactive) color = COLOR_TEXT_SUBTLE;
          const field = item.kind === 'field' ? fieldErrors[item.field] : undefined;
          return (
            <Box key={`${item.kind}-${index}-${label}`} flexDirection="column">
              <Box flexDirection="row">
                <Text color={color} bold={selected || (item.kind === 'action' && item.tone === 'destructive')}>
                  {prefix}
                  {label}
                </Text>
                {item.kind === 'entry' && entryShape === 'entries' ? (
                  <Text color={selected ? COLOR_TEXT : COLOR_TEXT_SUBTLE}>
                    {'  '}· Provider: {formatSubagentPoolProvider(item.entry.provider, roleLabel)} · Reasoning:{' '}
                    {formatSubagentPoolReasoning(item.entry.reasoningEffort, roleLabel)}
                  </Text>
                ) : null}
              </Box>
              {field && <Text color={COLOR_DANGER}> ⚠ {field}</Text>}
            </Box>
          );
        }}
      />
    </Box>
  );
}

export default SubagentPoolSelectionMenu;
