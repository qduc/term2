import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import type { SettingsPickerItem, TuiIntegration } from './integration.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

type Api = NonNullable<TuiIntegration['settingsPicker']>;

/** The picker owns keys; all mutations still go through the app's settings command. */
export function SettingsPicker({
  api,
  sessionId,
  inputHandler,
  onClose,
  run,
  onNotice,
}: {
  api: Api;
  sessionId: string;
  inputHandler: InteractionInput;
  onClose(): void;
  run(text: string): Promise<{ message?: string }>;
  onNotice(text: string | null): void;
}): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const [categories, setCategories] = useState(() => api.list(sessionId));
  const [tab, setTab] = useState(0);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<SettingsPickerItem | null>(null);
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const q = filter.toLowerCase();
  const tabs = categories.filter((category) => !category.searchOnly);
  const entries = (q ? categories.flatMap((category) => category.items) : tabs[tab]?.items ?? []).filter((item) =>
    `${item.label} ${item.key} ${item.description}`.toLowerCase().includes(q),
  );
  const index = Math.min(selected, Math.max(0, entries.length - 1));
  const item = entries[index];
  useInteractionInput(inputHandler, (input, key) => {
    if (pending.current) {
      if (key.escape) {
        mounted.current = false;
        onNotice('Setting change is still in progress; closing does not cancel it.');
        onClose();
      }
      return;
    }
    if (key.escape) {
      if (editing) {
        setEditing(null);
        setValue('');
        setNotice('');
      } else onClose();
      return;
    }
    if (editing) {
      if (key.return) {
        if (!value.trim()) {
          setNotice('Enter a value, or Esc to cancel.');
          return;
        }
        pending.current = true;
        setNotice('Applying…');
        void run(`/settings ${editing.key} ${value}`)
          .then(
            (result) => {
              if (mounted.current) {
                setCategories(api.list(sessionId));
                // Preserve the entered value even if the command returned a rejection.
                setNotice(result.message ?? 'Request finished.');
              } else onNotice(result.message ?? 'Setting change finished.');
            },
            (error) => {
              const message = error instanceof Error ? error.message : String(error);
              if (mounted.current) setNotice(message);
              else onNotice(message);
            },
          )
          .finally(() => {
            pending.current = false;
          });
      } else if (key.backspace || key.delete) setValue((current) => current.slice(0, -1));
      else if (!key.ctrl && !key.meta && input) setValue((current) => current + input);
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      setTab((current) => (current + (key.shift || key.leftArrow ? tabs.length - 1 : 1)) % tabs.length);
      setFilter('');
      setSelected(0);
      setNotice('');
      return;
    }
    if (key.upArrow) {
      setSelected(Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(Math.min(Math.max(0, entries.length - 1), index + 1));
      return;
    }
    if (key.return && item) {
      if (!item.editable) {
        setNotice(item.reason ?? 'This setting is read-only here.');
        return;
      }
      setEditing(item);
      setValue('');
      setNotice('');
      return;
    }
    if (key.backspace || key.delete) {
      setFilter((current) => current.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setFilter((current) => current + input);
      setSelected(0);
    }
  });
  const rows = Math.max(1, Math.min(7, (stdout.rows ?? 24) - 14));
  const start = Math.max(0, Math.min(index, entries.length - rows));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.borderActive} paddingX={1}>
      <Text bold>
        Settings · {tabs.map((category, i) => (i === tab ? `[${category.label}]` : category.label)).join('  ')}
      </Text>
      <Text>Search: {filter || '(type to search all categories)'}</Text>
      {entries.slice(start, start + rows).map((entry, i) => (
        <Text key={entry.key} color={i + start === index ? theme.accent : undefined} wrap="truncate">
          {i + start === index ? '❯' : ' '} {entry.label} · {entry.key}: {entry.current}
        </Text>
      ))}
      {!entries.length ? <Text>No matching settings.</Text> : null}
      {item ? (
        <Box flexDirection="column">
          <Text wrap="truncate">{item.description || item.label}</Text>
          <Text wrap="truncate">
            Current: {item.current} · Default: {item.defaultValue}
          </Text>
          {item.reason ? <Text wrap="truncate">{item.reason}</Text> : null}
        </Box>
      ) : null}
      {editing ? (
        <Text>
          Editing {editing.key}: {value}▏
        </Text>
      ) : null}
      {notice ? <Text wrap="truncate">{notice}</Text> : null}
      <Text>
        {editing ? 'Enter apply · Esc cancel edit' : 'Type search · Tab category · ↑/↓ select · Enter edit · Esc close'}
      </Text>
    </Box>
  );
}
