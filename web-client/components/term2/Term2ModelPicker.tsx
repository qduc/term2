'use client';

import { memo, useCallback, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ModelSummary, SessionConfigRecord, SessionConfigUpdate, SettingsProjection } from '../../lib/term2/types';
import {
  VirtualModelList,
  buildVirtualModelLayout,
  type SelectableModelItem,
} from './Term2ModelPickerList';
import {
  EffortBars,
  ProviderTabBar,
  REASONING_LEVELS,
  ReasoningEffortSection,
  chipModelName,
  type PickerTab,
  type ProviderTabItem,
} from './Term2ModelPickerSections';

export { REASONING_LEVELS, chipModelName } from './Term2ModelPickerSections';

const providerCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

export interface Term2ModelPickerProps {
  config: SessionConfigRecord;
  models: ModelSummary[];
  loadingModels: boolean;
  settings: SettingsProjection | null;
  disabled: boolean;
  busy: boolean;
  onSelectModel: (provider: string, model: string) => void;
  onSelectEffort: (effort: NonNullable<SessionConfigUpdate['reasoningEffort']>) => void;
  onToggleFavorite?: (favoriteKey: string) => void;
  onRefreshModels: () => void;
  onOpenSettings: () => void;
  /** The shown model or effort is staged and not yet applied to the chat. */
  pending?: boolean;
  /** One line shown at the top of the panel, e.g. how picks apply here. */
  note?: string;
  /** Shown on the chip and in the panel when the selected model may not work. */
  warning?: string;
}

export const Term2ModelPicker = memo(function Term2ModelPicker({
  config,
  models,
  loadingModels,
  settings,
  disabled,
  busy,
  onSelectModel,
  onSelectEffort,
  onToggleFavorite,
  onRefreshModels,
  onOpenSettings,
  pending = false,
  note,
  warning,
}: Term2ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<PickerTab>('all');

  const providerLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of settings?.settings.providers ?? []) map.set(p.id, p.label);
    return map;
  }, [settings]);

  const effortValue = config.reasoningEffort || 'default';
  const currentEffortMeta = REASONING_LEVELS.find((item) => item.value === effortValue);
  const chipProvider = providerLabels.get(config.providerId) ?? config.providerId;
  const currentModel = useMemo(
    () => models.find((m) => m.provider === config.providerId && m.id === config.modelId),
    [models, config.providerId, config.modelId],
  );
  const chipName = chipModelName(config.modelId, currentModel?.name);
  const effortLabel = currentEffortMeta?.label ?? effortValue;
  const showEffortInChip = effortValue !== 'default';

  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled || busy}
            aria-label="Choose model and reasoning effort"
            title={`Provider: ${chipProvider} · Model: ${config.modelId} · Reasoning effort: ${effortLabel}${
              pending ? ' · applies when you send your next message' : ''
            }${warning ? ` · ${warning}` : ''}`}
            className={cn(
              'max-w-[min(20rem,42vw)] rounded-full',
              pending && 'border-dashed',
              warning && 'border-amber-500/60 text-amber-800 dark:text-amber-300',
            )}
          >
            {warning && !busy && <TriangleAlert aria-label="Model may be unavailable" className="text-amber-500" />}
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {pending && !busy && (
              <span aria-label="Pending change" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            )}
            <span className="max-w-[8rem] shrink-0 truncate text-muted-foreground">{chipProvider}</span>
            <span className="min-w-0 truncate">{config.modelId ? chipName : 'Choose a model'}</span>
            {showEffortInChip && <EffortBars effort={effortValue} label={effortLabel} />}
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Select model"
          className="flex h-[min(28rem,calc(100dvh-6rem))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
          <ModelPickerPanel
            config={config}
            models={models}
            loadingModels={loadingModels}
            settings={settings}
            providerLabels={providerLabels}
            effortValue={effortValue}
            disabled={disabled}
            busy={busy}
            query={query}
            tab={tab}
            note={note}
            warning={warning}
            onQueryChange={setQuery}
            onTabChange={setTab}
            onSelectModel={onSelectModel}
            onSelectEffort={onSelectEffort}
            onToggleFavorite={onToggleFavorite}
            onRefreshModels={onRefreshModels}
            onOpenSettings={onOpenSettings}
            onClose={handleClose}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
});

function ModelPickerPanel({
  config,
  models,
  loadingModels,
  settings,
  providerLabels,
  effortValue,
  disabled,
  busy,
  query,
  tab,
  note,
  warning,
  onQueryChange,
  onTabChange,
  onSelectModel,
  onSelectEffort,
  onToggleFavorite,
  onRefreshModels,
  onOpenSettings,
  onClose,
}: {
  config: SessionConfigRecord;
  models: ModelSummary[];
  loadingModels: boolean;
  settings: SettingsProjection | null;
  providerLabels: ReadonlyMap<string, string>;
  effortValue: string;
  disabled: boolean;
  busy: boolean;
  query: string;
  tab: PickerTab;
  note?: string;
  warning?: string;
  onQueryChange: (query: string) => void;
  onTabChange: (tab: PickerTab) => void;
  onSelectModel: (provider: string, model: string) => void;
  onSelectEffort: (effort: NonNullable<SessionConfigUpdate['reasoningEffort']>) => void;
  onToggleFavorite?: (favoriteKey: string) => void;
  onRefreshModels: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ tick: number; mode: 'center' | 'nearest' }>({
    tick: 0,
    mode: 'center',
  });

  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const favoriteSet = useMemo(() => {
    const raw = settings?.settings.safeDefaults['agent.favoriteModels']?.value;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  }, [settings]);

  const compareProviders = useCallback(
    (a: string, b: string) => {
      if (a === config.providerId && b !== config.providerId) return -1;
      if (b === config.providerId && a !== config.providerId) return 1;
      const labelA = providerLabels.get(a) ?? a;
      const labelB = providerLabels.get(b) ?? b;
      const byLabel = providerCollator.compare(labelA, labelB);
      return byLabel !== 0 ? byLabel : a.localeCompare(b);
    },
    [config.providerId, providerLabels],
  );

  const { providerCounts, providerOrder, favoriteCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let favorites = 0;
    for (const model of models) {
      counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
      const favKey = `${model.provider}/${model.id}`;
      if (favoriteSet.has(favKey) || favoriteSet.has(model.id)) favorites += 1;
    }
    const order = [...counts.keys()].sort(compareProviders);
    return { providerCounts: counts, providerOrder: order, favoriteCount: favorites };
  }, [models, favoriteSet, compareProviders]);

  const effectiveTab: PickerTab =
    tab.startsWith('provider:') && !providerCounts.has(tab.slice('provider:'.length)) ? 'all' : tab;
  const activeProviderId = effectiveTab.startsWith('provider:') ? effectiveTab.slice('provider:'.length) : null;

  const tabItems = useMemo<ProviderTabItem[]>(
    () => [
      { id: 'all', label: 'All', count: models.length },
      { id: 'favorites', label: 'Favorites', count: favoriteCount },
      ...providerOrder.map((id) => ({
        id: `provider:${id}` as PickerTab,
        label: providerLabels.get(id) ?? id,
        count: providerCounts.get(id) ?? 0,
      })),
    ],
    [models.length, favoriteCount, providerOrder, providerLabels, providerCounts],
  );

  const groupedModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, ModelSummary[]>();
    for (const model of models) {
      const favKey = `${model.provider}/${model.id}`;
      if (effectiveTab === 'favorites' && !favoriteSet.has(favKey) && !favoriteSet.has(model.id)) continue;
      if (activeProviderId !== null && model.provider !== activeProviderId) continue;
      if (needle) {
        const providerLabel = (providerLabels.get(model.provider) ?? model.provider).toLowerCase();
        const hay = `${model.id} ${model.name ?? ''} ${model.provider} ${providerLabel}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort(([a], [b]) => compareProviders(a, b));
  }, [models, query, effectiveTab, activeProviderId, favoriteSet, providerLabels, compareProviders]);

  const trimmedQuery = query.trim();
  const exactInList = useMemo(
    () => (trimmedQuery ? models.some((m) => m.id === trimmedQuery || `${m.provider}/${m.id}` === trimmedQuery) : true),
    [models, trimmedQuery],
  );

  const layout = useMemo(
    () => buildVirtualModelLayout(groupedModels, activeProviderId === null, providerLabels, trimmedQuery && !exactInList ? trimmedQuery : null),
    [groupedModels, activeProviderId, providerLabels, trimmedQuery, exactInList],
  );

  const activeIndex = useMemo(() => {
    const { selectableItems } = layout;
    if (selectableItems.length === 0) return -1;
    if (activeKey !== null) {
      const idx = selectableItems.findIndex((item) => item.key === activeKey);
      if (idx !== -1) return idx;
    }
    if (!trimmedQuery) {
      const currentIdx = selectableItems.findIndex(
        (item) =>
          item.kind === 'model' && item.model.provider === config.providerId && item.model.id === config.modelId,
      );
      if (currentIdx !== -1) return currentIdx;
    }
    return 0;
  }, [layout, activeKey, trimmedQuery, config.providerId, config.modelId]);

  const selectTab = useCallback(
    (nextTab: PickerTab) => {
      onTabChange(nextTab);
      setActiveKey(null);
      setScrollRequest((prev) => ({ tick: prev.tick + 1, mode: 'nearest' }));
    },
    [onTabChange],
  );

  const pickCustom = useCallback(() => {
    if (!trimmedQuery) return;
    const slash = trimmedQuery.indexOf('/');
    if (slash > 0 && slash < trimmedQuery.length - 1) {
      onSelectModel(trimmedQuery.slice(0, slash), trimmedQuery.slice(slash + 1));
    } else {
      onSelectModel(activeProviderId ?? config.providerId, trimmedQuery);
    }
    onClose();
    onQueryChange('');
  }, [trimmedQuery, onSelectModel, activeProviderId, config.providerId, onClose, onQueryChange]);

  const handleSelectModelRow = useCallback(
    (provider: string, modelId: string) => {
      onSelectModel(provider, modelId);
      onClose();
      onQueryChange('');
    },
    [onSelectModel, onClose, onQueryChange],
  );

  const handleHoverKey = useCallback((key: string) => {
    setActiveKey((prev) => (prev === key ? prev : key));
  }, []);

  const handleConnectProvider = useCallback(() => {
    onClose();
    onOpenSettings();
  }, [onClose, onOpenSettings]);

  const commitItem = useCallback(
    (item: SelectableModelItem) => {
      if (item.kind === 'custom') {
        pickCustom();
        return;
      }
      handleSelectModelRow(item.model.provider, item.model.id);
    },
    [pickCustom, handleSelectModelRow],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const { selectableItems } = layout;
          if (selectableItems.length === 0) return;
          event.preventDefault();
          const nextIndex =
            event.key === 'ArrowDown'
              ? activeIndex === -1
                ? 0
                : (activeIndex + 1) % selectableItems.length
              : activeIndex <= 0
                ? selectableItems.length - 1
                : activeIndex - 1;
          setActiveKey(selectableItems[nextIndex]!.key);
          setScrollRequest((prev) => ({ tick: prev.tick + 1, mode: 'nearest' }));
          if (document.activeElement !== searchInputRef.current) {
            searchInputRef.current?.focus({ preventScroll: true });
          }
          return;
        }
        if (event.key === 'Enter' && event.target === searchInputRef.current) {
          if (activeIndex < 0) return;
          const chosen = layout.selectableItems[activeIndex];
          if (!chosen) return;
          event.preventDefault();
          commitItem(chosen);
        }
      }}
    >
      {warning && (
        <p role="status" className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          {warning}
        </p>
      )}
      {note && <p className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">{note}</p>}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={searchInputRef}
          type="search"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActiveKey(null);
            setScrollRequest((prev) => ({ tick: prev.tick + 1, mode: 'nearest' }));
          }}
          placeholder="Search models or type provider/model…"
          aria-label="Filter models"
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onRefreshModels}
          disabled={loadingModels}
          title="Refresh model list"
          aria-label="Refresh model list"
        >
          <RefreshCw className={loadingModels ? 'animate-spin' : ''} />
        </Button>
      </div>
      <ProviderTabBar tabs={tabItems} activeTab={effectiveTab} onSelectTab={selectTab} />
      <VirtualModelList
        listboxId={listboxId}
        layout={layout}
        activeIndex={activeIndex}
        scrollRequest={scrollRequest}
        currentProviderId={config.providerId}
        currentModelId={config.modelId}
        favoriteSet={favoriteSet}
        loadingModels={loadingModels}
        totalModelCount={models.length}
        hasGroupedModels={groupedModels.length > 0}
        effectiveTab={effectiveTab}
        activeProviderId={activeProviderId}
        query={query}
        providerLabels={providerLabels}
        onSelectTab={selectTab}
        onHoverKey={handleHoverKey}
        onSelectModel={handleSelectModelRow}
        onPickCustom={pickCustom}
        onToggleFavorite={onToggleFavorite}
        onConnectProvider={handleConnectProvider}
      />
      <ReasoningEffortSection
        effortValue={effortValue}
        disabled={disabled}
        busy={busy}
        onSelectEffort={onSelectEffort}
      />
      <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs">
        <span className="text-muted-foreground">↑↓ navigate · ↵ select</span>
        <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={handleConnectProvider}>
          Manage providers
        </Button>
      </div>
    </div>
  );
}
