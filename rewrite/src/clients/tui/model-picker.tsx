import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { GLYPH_FAVORITE, GLYPH_SEPARATOR, GLYPH_WARNING, useTheme } from './presentation/components/theme.js';
import type { PickerModel, TuiIntegration } from './integration.js';
import { useInteractionInput, type InteractionInput } from './interaction-input.js';

type Api = NonNullable<TuiIntegration['modelPicker']>;
const identity = (m: PickerModel) => `${m.provider}/${m.id}`;

/** Same order as the old menu: Tab and Right advance, Left moves back, both wrap. */
const TABS = ['favorites', 'nicknames', 'all'] as const;
type ModelTab = (typeof TABS)[number];
const TAB_LABEL: Record<ModelTab, string> = { favorites: 'Favorites', nicknames: 'Nicknames', all: 'All' };

function stepTab(tab: ModelTab, direction: 1 | -1): ModelTab {
  return TABS[(TABS.indexOf(tab) + direction + TABS.length) % TABS.length]!;
}

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
  const [tab, setTab] = useState<ModelTab>('favorites');
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
  const named = (model: PickerModel) => (nicknames[identity(model)]?.length ?? 0) > 0;
  const catalog = models ?? [];
  const byKey = new Map<string, PickerModel>();
  for (const model of [...favorites, ...catalog]) byKey.set(identity(model), model);
  const source = tab === 'favorites' ? favorites : tab === 'nicknames' ? [...byKey.values()].filter(named) : catalog;
  const visible = source.filter((model) =>
    `${identity(model)} ${model.name ?? ''} ${(nicknames[identity(model)] ?? []).join(' ')}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  const index = Math.min(selected, Math.max(0, visible.length - 1));
  useInteractionInput(inputHandler, (input, key) => {
    if (key.escape) return onClose();
    if (key.tab || key.rightArrow) {
      setTab(stepTab(tab, 1));
      setSelected(0);
      return;
    }
    if (key.leftArrow) {
      setTab(stepTab(tab, -1));
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
  const rows = visible.slice(start, start + 10);
  const providerWidth = Math.max(1, ...rows.map((model) => model.provider.length));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold>Choose a model</Text>
      <Box>
        {TABS.map((id, tabIndex) => (
          <Box key={id}>
            {tabIndex > 0 && <Text color={theme.textSubtle}>{` ${GLYPH_SEPARATOR} `}</Text>}
            <Text inverse={tab === id} color={tab === id ? theme.accent : theme.textSubtle} bold={tab === id}>
              {` ${TAB_LABEL[id]} `}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.textSubtle}>Filter: {filter || 'type to filter'}</Text>
      {rows.map((model, row) => {
        const key = identity(model);
        const selectedRow = row + start === index;
        const aka = nicknames[key];
        const previous = rows[row - 1];
        return (
          <Box key={key}>
            <Box
              width={providerWidth}
              flexShrink={0}
              marginRight={1}
              borderStyle="single"
              borderTop={false}
              borderBottom={false}
              borderLeft={false}
              borderColor={theme.border}
            >
              <Text bold wrap="truncate">
                {!previous || previous.provider !== model.provider ? model.provider : ' '}
              </Text>
            </Box>
            <Text wrap="truncate-end">
              {selectedRow ? '❯' : ' '}{' '}
              <Text color={theme.accent}>{favoriteKeys.has(key) ? `${GLYPH_FAVORITE} ` : '  '}</Text>
              <Text color={selectedRow ? theme.accent : undefined} bold={selectedRow}>
                {model.id}
                {model.name && model.name !== model.id ? ` · ${model.name}` : ''}
              </Text>
              {aka?.length ? <Text color={theme.accent}>{` — aka "${aka.join('", "')}"`}</Text> : null}
              {key === current && <Text color={theme.success}> (current)</Text>}
            </Text>
          </Box>
        );
      })}
      {!visible.length && (
        <Text color={theme.textSubtle}>
          {tab === 'all' && models === null && !error ? 'Loading models…' : 'No matching models.'}
        </Text>
      )}
      {failedProviders.length > 0 && (
        <Text color={theme.warning}>
          {GLYPH_WARNING} Some providers failed: {failedProviders.join(', ')}
        </Text>
      )}
      {error && <Text color={theme.warning}>{error}</Text>}
      <Text color={theme.textSubtle}>Tab/←→ switch · ↑/↓ select · Ctrl+F favorite · Enter choose · Esc cancel</Text>
    </Box>
  );
}
