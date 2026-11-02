import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { WireRewindTarget } from '../../protocol/direct-wire.js';

/** Pick the Session-provided target, then explicitly choose edit or resend. */
export function RewindPicker({
  targets,
  onClose,
  onSelect,
}: {
  readonly targets: readonly WireRewindTarget[];
  readonly onClose: () => void;
  readonly onSelect: (targetId: string, disposition: 'edit' | 'resend') => void;
}): React.ReactElement {
  const [selected, setSelected] = useState(Math.max(0, targets.length - 1));
  const [target, setTarget] = useState<WireRewindTarget | null>(null);
  const [action, setAction] = useState(0);
  useInput((input, key) => {
    if (key.escape) {
      if (target) setTarget(null);
      else onClose();
      return;
    }
    if (key.upArrow) {
      if (target) setAction(0);
      else setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      if (target) setAction(1);
      else setSelected((i) => Math.min(targets.length - 1, i + 1));
      return;
    }
    const number = /^[1-9]$/.test(input) ? Number(input) - 1 : -1;
    if (!key.return && number < 0) return;
    const position = number < 0 ? (target ? action : selected) : number;
    if (target) {
      if (position < 2) onSelect(target.id, position === 0 ? 'edit' : 'resend');
    } else if (targets[position]) setTarget(targets[position]);
  });
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{target ? `Rewind: ${target.label}` : 'Choose a turn to rewind'}</Text>
      {(target ? ['Edit in composer', 'Resend'] : targets.map((item) => item.label)).map((label, index) => (
        <Text key={index}>
          {index === (target ? action : selected) ? '❯' : ' '} {index + 1}. {label}
        </Text>
      ))}
      <Text>↑/↓ select · Enter choose · Esc back</Text>
    </Box>
  );
}
