import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from './presentation/components/theme.js';
import type { PickerModel, TuiIntegration } from './integration.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

type Api = NonNullable<TuiIntegration['modelPicker']>;
const identity = (m: PickerModel) => `${m.provider}/${m.id}`;

/** The session owns the stable input listener (the same ref the interaction panel uses; opening this picker suppresses that panel); this panel publishes its current handler. */
export function ModelPicker({
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
  /** Runs the `/model` command for the chosen model; its message (or failure) is shown as a notice. */
  run(text: string): Promise<{ message?: string }>;
  onNotice(text: string | null): void;
}): React.ReactElement {
  const theme = useTheme();
  const current = identity(api.current(sessionId));
  const [failedProviders, setFailedProviders] = useState<string[]>([]);
  const [favorites, setFavorites] = useState(() => api.favorites(sessionId));
  const nicknames = api.nicknames(sessionId);
  const [models, setModels] = useState<PickerModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'favorites' | 'all'>('favorites');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let mounted = true;
    api.list(sessionId).then(
      (list) => {
        if (mounted) {
          setModels(list.models);
          setFailedProviders(list.failedProviders);
        }
      },
      (err) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      mounted = false;
    };
  }, [api, sessionId]);
  const favoriteKeys = new Set(favorites.map(identity));
  const visible = (tab === 'favorites' ? favorites : models ?? []).filter((model) =>
    `${identity(model)} ${model.name ?? ''} ${(nicknames[identity(model)] ?? []).join(' ')}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  useInteractionInput(inputHandler, (input, key) => {
    if (key.escape) return onClose();
    if (key.tab || key.leftArrow || key.rightArrow) {
      setTab(tab === 'favorites' ? 'all' : 'favorites');
      setSelected(0);
      return;
    }
    if (key.upArrow) {
      setSelected(Math.max(0, index - 1));
      return;
    }
    if (key.downArrow) {
      setSelected(Math.min(visible.length - 1, index + 1));
      return;
    }
    if (key.return) {
      const model = visible[index];
      if (model) {
        onClose();
        run(`/model ${model.provider}/${model.id}`).then(
          (result) => onNotice(result.message ?? null),
          (failure) => onNotice(failure instanceof Error ? failure.message : String(failure)),
        );
      }
      return;
    }
    if (key.ctrl && input === 'f') {
      if (visible[index]) {
        try {
          api.toggle(sessionId, visible[index]);
          setFavorites(api.favorites(sessionId));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      return;
    }
    if (key.backspace || key.delete) {
      setFilter(filter.slice(0, -1));
      setSelected(0);
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      setFilter(filter + input);
      setSelected(0);
    }
  });
  const start = Math.max(0, index - 5);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold>
        Choose a model ·{' '}
        <Text color={tab === 'favorites' ? theme.accent : theme.textMuted}>
          {tab === 'favorites' ? '[Favorites]' : 'Favorites'}
        </Text>{' '}
        <Text color={tab === 'all' ? theme.accent : theme.textMuted}>{tab === 'all' ? '[All]' : 'All'}</Text>
      </Text>
      <Text>Filter: {filter}</Text>
      <Box>
        <Box width={38} flexShrink={1}>
          <Text> Model</Text>
        </Box>
        <Text>Provider / nickname</Text>
      </Box>
      {visible.slice(start, start + 10).map((model, i) => (
        <Box key={identity(model)}>
          <Box width={38} flexShrink={1}>
            <Text wrap="truncate-end">
              {i + start === index ? '❯' : ' '} {favoriteKeys.has(identity(model)) ? '★' : '☆'} {model.id}
              {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
              {identity(model) === current && <Text color={theme.success}> (current)</Text>}
            </Text>
          </Box>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              {model.provider}
              {nicknames[identity(model)]?.length ? ` · aka ${nicknames[identity(model)]!.join(', ')}` : ''}
            </Text>
          </Box>
        </Box>
      ))}
      {!visible.length && (
        <Text>{tab === 'all' && models === null && !error ? 'Loading models…' : 'No matching models.'}</Text>
      )}
      {failedProviders.length > 0 && (
        <Text color={theme.warning}>▲ Some providers failed: {failedProviders.join(', ')}</Text>
      )}
      {error && <Text color={theme.warning}>{error}</Text>}
      <Text>Tab switch · ↑/↓ select · Ctrl+F favorite · Enter choose · Esc cancel</Text>
    </Box>
  );
}
