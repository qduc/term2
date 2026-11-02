import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
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
  const [favorites, setFavorites] = useState(() => api.favorites(sessionId));
  const [models, setModels] = useState<PickerModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'favorites' | 'all'>('favorites');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(0);
  useEffect(() => {
    let mounted = true;
    api.list(sessionId).then(
      (list) => {
        if (mounted) setModels(list);
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
    `${identity(model)} ${model.name ?? ''}`.toLowerCase().includes(filter.toLowerCase()),
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
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Choose a model · {tab === 'favorites' ? '[Favorites]  All' : 'Favorites  [All]'}</Text>
      <Text>Filter: {filter}</Text>
      {visible.slice(start, start + 10).map((model, i) => (
        <Text key={identity(model)}>
          {i + start === index ? '❯' : ' '} {favoriteKeys.has(identity(model)) ? '★' : '☆'} {identity(model)}
          {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
        </Text>
      ))}
      {!visible.length && (
        <Text>{tab === 'all' && models === null && !error ? 'Loading models…' : 'No matching models.'}</Text>
      )}
      {error && <Text>{error}</Text>}
      <Text>Tab switch · ↑/↓ select · Ctrl+F favorite · Enter choose · Esc cancel</Text>
    </Box>
  );
}
