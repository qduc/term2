import React, { useEffect, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import type { TuiIntegration } from './integration.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

type Api = NonNullable<TuiIntegration['resumePicker']>;

function relativeTime(value?: string): string {
  if (!value || Number.isNaN(Date.parse(value))) return 'unknown time';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

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
  const theme = useTheme();
  const { stdout } = useStdout();
  const wide = (stdout.columns ?? 80) >= 70;
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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
      <Text bold>Resume Conversation</Text>
      {sessions === null && !error ? <Text>Loading conversations…</Text> : null}
      {sessions?.length === 0 ? <Text>No direct sessions in this workspace.</Text> : null}
      {error ? <Text>{error}</Text> : null}
      {sessions?.length ? (
        <Box flexDirection={wide ? 'row' : 'column'}>
          <Box flexDirection="column" width={wide ? '50%' : '100%'}>
            {sessions.slice(start, start + 8).map((item, index) => (
              <Text key={item.id} color={start + index === selected ? theme.accent : undefined} wrap="truncate">
                {start + index === selected ? '❯' : ' '} {item.firstUserMessage || item.title || '(no messages yet)'} ·{' '}
                {relativeTime(item.updatedAt)}
                {item.messageCount !== undefined ? ` · ${item.messageCount} msgs` : ''}
              </Text>
            ))}
          </Box>
          {current ? (
            <Box flexDirection="column" width={wide ? '50%' : '100%'} paddingLeft={wide ? 1 : 0}>
              <Text bold>Preview</Text>
              <Text wrap="truncate">ID: {current.id}</Text>
              <Text>Updated: {current.updatedAt ? new Date(current.updatedAt).toLocaleString() : 'unknown'}</Text>
              {current.model ? <Text wrap="truncate">Model: {current.model}</Text> : null}
              <Text wrap="truncate">
                Initial Prompt: {current.firstUserMessage || current.title || '(no messages yet)'}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Text>↑/↓ select · Enter resume · Esc cancel</Text>
    </Box>
  );
}
