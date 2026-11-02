import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { TuiIntegration } from './integration.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

type Api = NonNullable<TuiIntegration['resumePicker']>;

/** Browse workspace conversations; the selected summary is the preview. */
export function ResumePicker({
  api,
  inputHandler,
  onClose,
  onSelect,
}: {
  api: Api;
  inputHandler: InteractionInput;
  onClose(): void;
  onSelect(id: string): void;
}): React.ReactElement {
  const [sessions, setSessions] = useState<Awaited<ReturnType<Api['list']>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let mounted = true;
    void api.list().then(
      (list) => {
        if (mounted) setSessions(list);
      },
      (err) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      mounted = false;
    };
  }, [api]);
  useInteractionInput(inputHandler, (_input, key) => {
    if (key.escape) onClose();
    else if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(Math.max(0, (sessions?.length ?? 0) - 1), i + 1));
    else if (key.return && sessions?.[selected]) onSelect(sessions[selected]!.id);
  });
  const current = sessions?.[selected];
  const start = Math.max(0, selected - 4);
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Resume a conversation</Text>
      {sessions === null && !error ? <Text>Loading conversations…</Text> : null}
      {sessions?.length === 0 ? <Text>No direct sessions in this workspace.</Text> : null}
      {sessions?.slice(start, start + 8).map((item, index) => (
        <Text key={item.id}>
          {start + index === selected ? '❯' : ' '} {item.id}{' '}
          {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ''}
        </Text>
      ))}
      {current ? <Text>Preview: {current.title || '(no messages yet)'}</Text> : null}
      {error ? <Text>{error}</Text> : null}
      <Text>↑/↓ select · Enter resume · Esc cancel</Text>
    </Box>
  );
}
