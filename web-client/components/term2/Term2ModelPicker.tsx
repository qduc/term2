'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Minus, RefreshCw, Search, Star, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ModelSummary, SessionConfigRecord, SessionConfigUpdate, SettingsProjection } from '../../lib/term2/types';

export const REASONING_LEVELS: ReadonlyArray<{
  value: NonNullable<SessionConfigUpdate['reasoningEffort']>;
  label: string;
  hint: string;
}> = [
  { value: 'default', label: 'Default', hint: 'Use model default reasoning' },
  { value: 'none', label: 'Off', hint: 'No extended reasoning' },
  { value: 'minimal', label: 'Minimal', hint: 'Fastest, lightest reasoning' },
  { value: 'low', label: 'Low', hint: 'Quick reasoning for simple tasks' },
  { value: 'medium', label: 'Medium', hint: 'Balanced depth and speed' },
  { value: 'high', label: 'High', hint: 'Deep reasoning for hard tasks' },
  { value: 'xhigh', label: 'Extra high', hint: 'Maximum reasoning effort' },
];

/** Short labels so all levels fit one segmented control; the full label and hint show on hover. */
const EFFORT_SHORT_LABELS: Record<string, string> = {
  none: 'Off',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Extra high',
};

/**
 * The levels offered in the picker. `default` and `minimal` stay in REASONING_LEVELS so a chat
 * already set to one still shows its name, but they are no longer offered.
 */
const PICKER_LEVELS = REASONING_LEVELS.filter((level) =>
  ['none', 'low', 'medium', 'high', 'xhigh'].includes(level.value),
);

function formatContextWindow(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M tokens`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K tokens`;
  return `${tokens} tokens`;
}

function formatPrice(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (value === 0) return 'Free';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 0.1 ? 4 : 2 })}`;
}

/** What term2 knows about a model: limits and prices from its catalog. Shown on hover or focus. */
function ModelDetails({ model, providerLabel }: { model: ModelSummary; providerLabel: string }) {
  const rows: Array<[string, string]> = [];
  if (model.contextWindow) rows.push(['Context', formatTokens(model.contextWindow)]);
  if (model.maxOutputTokens) rows.push(['Max output', formatTokens(model.maxOutputTokens)]);
  const pricing = model.pricing;
  const input = formatPrice(pricing?.inputPerMTok);
  const output = formatPrice(pricing?.outputPerMTok);
  if (input) rows.push(['Input', `${input} / 1M tokens`]);
  if (output) rows.push(['Output', `${output} / 1M tokens`]);
  const cacheRead = formatPrice(pricing?.cacheReadPerMTok);
  const cacheWrite = formatPrice(pricing?.cacheWritePerMTok);
  if (cacheRead) rows.push(['Cache read', `${cacheRead} / 1M tokens`]);
  if (cacheWrite) rows.push(['Cache write', `${cacheWrite} / 1M tokens`]);
  if (model.default_reasoning_level) rows.push(['Default reasoning', model.default_reasoning_level]);
  return (
    <div className="space-y-1.5">
      <div>
        <div className="break-all font-mono font-medium">{model.id}</div>
        <div className="opacity-70">
          {model.name && model.name !== model.id ? `${model.name} · ` : ''}
          {providerLabel}
        </div>
      </div>
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="opacity-70">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="opacity-70">No limits or prices known for this model.</p>
      )}
      {pricing?.tiers?.map((tier) => (
        <p key={tier.inputTokensAbove} className="opacity-70">
          Above {formatTokens(tier.inputTokensAbove).replace(' tokens', '')} input:{' '}
          {[
            formatPrice(tier.inputPerMTok) && `${formatPrice(tier.inputPerMTok)} in`,
            formatPrice(tier.outputPerMTok) && `${formatPrice(tier.outputPerMTok)} out`,
          ]
            .filter(Boolean)
            .join(', ')}{' '}
          per 1M
        </p>
      ))}
    </div>
  );
}

/**
 * A short, readable model name for the chip: the catalog name without its "Vendor: " prefix
 * (the provider is shown beside it), or the id without its `vendor/` part when there is no name.
 */
export function chipModelName(modelId: string, name?: string): string {
  const cleaned = name?.replace(/^[^:/]{1,40}:\s+/, '').trim();
  if (cleaned && cleaned !== modelId) return cleaned;
  return modelId.includes('/') ? modelId.slice(modelId.lastIndexOf('/') + 1) : modelId;
}

/** Bars filled per effort level; Extra high fills all three in the accent colour. */
const EFFORT_BARS: Record<string, number> = { minimal: 1, low: 1, medium: 2, high: 3, xhigh: 3 };

function EffortBars({ effort, label }: { effort: string; label: string }) {
  if (effort === 'none') return <Minus aria-label={`Reasoning ${label}`} className="size-3 text-muted-foreground" />;
  const filled = EFFORT_BARS[effort];
  if (filled === undefined) return null;
  const strong = effort === 'xhigh';
  return (
    <span role="img" aria-label={`Reasoning effort ${label}`} className="inline-flex h-2.5 shrink-0 items-end gap-px">
      {[4, 7, 10].map((height, index) => (
        <span
          key={height}
          style={{ height }}
          className={cn(
            'w-[3px] rounded-[1px]',
            index < filled ? (strong ? 'bg-primary' : 'bg-foreground/70') : 'bg-foreground/20',
          )}
        />
      ))}
    </span>
  );
}

type PickerTab = 'all' | 'favorites' | `provider:${string}`;

type SelectableItem =
  | { kind: 'model'; key: string; model: ModelSummary }
  | { kind: 'custom'; key: '__custom__'; query: string };

export function Term2ModelPicker({
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
}: {
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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<PickerTab>('all');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [scrollTick, setScrollTick] = useState(0);

  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollModeRef = useRef<'nearest' | 'center' | null>(null);

  const favoriteSet = useMemo(() => {
    const raw = settings?.settings.safeDefaults['agent.favoriteModels']?.value;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  }, [settings]);

  const providerLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of settings?.settings.providers ?? []) map.set(p.id, p.label);
    return map;
  }, [settings]);

  const compareProviders = useCallback(
    (a: string, b: string) => {
      if (a === config.providerId && b !== config.providerId) return -1;
      if (b === config.providerId && a !== config.providerId) return 1;
      const labelA = providerLabels.get(a) ?? a;
      const labelB = providerLabels.get(b) ?? b;
      const byLabel = labelA.localeCompare(labelB, undefined, { sensitivity: 'base' });
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

  const tabItems = useMemo(
    () => [
      { id: 'all' as PickerTab, label: 'All', count: models.length },
      { id: 'favorites' as PickerTab, label: 'Favorites', count: favoriteCount },
      ...providerOrder.map((id) => ({
        id: `provider:${id}` as PickerTab,
        providerId: id,
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

  const effortValue = config.reasoningEffort || 'default';
  const currentEffortMeta = REASONING_LEVELS.find((item) => item.value === effortValue);
  const effortOffered = PICKER_LEVELS.some((level) => level.value === effortValue);
  const chipProvider = providerLabels.get(config.providerId) ?? config.providerId;
  const currentModel = models.find((m) => m.provider === config.providerId && m.id === config.modelId);
  const chipName = chipModelName(config.modelId, currentModel?.name);
  const effortLabel = currentEffortMeta?.label ?? effortValue;
  const showEffortInChip = effortValue !== 'default';

  const trimmedQuery = query.trim();
  const exactInList = models.some((m) => m.id === trimmedQuery || `${m.provider}/${m.id}` === trimmedQuery);

  const selectableItems = useMemo<SelectableItem[]>(() => {
    const items: SelectableItem[] = [];
    for (const [, list] of groupedModels) {
      for (const model of list) {
        items.push({ kind: 'model', key: `${model.provider}/${model.id}`, model });
      }
    }
    if (trimmedQuery && !exactInList) {
      items.push({ kind: 'custom', key: '__custom__', query: trimmedQuery });
    }
    return items;
  }, [groupedModels, trimmedQuery, exactInList]);

  const activeIndex = useMemo(() => {
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
  }, [selectableItems, activeKey, trimmedQuery, config.providerId, config.modelId]);

  const selectTab = (nextTab: PickerTab) => {
    setTab(nextTab);
    setActiveKey(null);
    scrollModeRef.current = 'nearest';
    setScrollTick((t) => t + 1);
  };

  const pickCustom = () => {
    if (!trimmedQuery) return;
    const slash = trimmedQuery.indexOf('/');
    if (slash > 0 && slash < trimmedQuery.length - 1) {
      onSelectModel(trimmedQuery.slice(0, slash), trimmedQuery.slice(slash + 1));
    } else {
      onSelectModel(activeProviderId ?? config.providerId, trimmedQuery);
    }
    setOpen(false);
    setQuery('');
  };

  const commitItem = (item: SelectableItem) => {
    if (item.kind === 'custom') {
      pickCustom();
      return;
    }
    onSelectModel(item.model.provider, item.model.id);
    setOpen(false);
    setQuery('');
  };

  useEffect(() => {
    if (!open || !scrollModeRef.current) return;
    const mode = scrollModeRef.current;
    scrollModeRef.current = null;
    const frame = requestAnimationFrame(() => {
      const container = listRef.current;
      if (!container) return;
      const activeEl = container.querySelector<HTMLElement>('[data-active="true"]');
      if (activeEl) {
        activeEl.scrollIntoView({ block: mode });
      } else {
        container.scrollTop = 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, scrollTick, effectiveTab]);

  const itemIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    selectableItems.forEach((item, index) => map.set(item.key, index));
    return map;
  }, [selectableItems]);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setActiveKey(null);
            scrollModeRef.current = 'center';
            setScrollTick((t) => t + 1);
          }
        }}
      >
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
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
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
              scrollModeRef.current = 'nearest';
              setScrollTick((t) => t + 1);
              if (document.activeElement !== searchInputRef.current) {
                searchInputRef.current?.focus({ preventScroll: true });
              }
              return;
            }
            if (event.key === 'Enter' && event.target === searchInputRef.current) {
              if (activeIndex < 0) return;
              const chosen = selectableItems[activeIndex];
              if (!chosen) return;
              event.preventDefault();
              commitItem(chosen);
            }
          }}
        >
          {warning && (
            <p
              role="status"
              className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300"
            >
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
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveKey(null);
                scrollModeRef.current = 'nearest';
                setScrollTick((t) => t + 1);
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
          <div
            role="tablist"
            aria-label="Filter models by provider"
            className="flex items-center gap-1 overflow-x-auto border-b px-3 py-1.5 text-xs scrollbar-thin"
            onKeyDown={(event) => {
              if (
                event.key !== 'ArrowLeft' &&
                event.key !== 'ArrowRight' &&
                event.key !== 'Home' &&
                event.key !== 'End'
              ) {
                return;
              }
              if (tabItems.length === 0) return;
              event.preventDefault();
              const currentIndex = tabItems.findIndex((item) => item.id === effectiveTab);
              let nextIndex = 0;
              if (event.key === 'Home') {
                nextIndex = 0;
              } else if (event.key === 'End') {
                nextIndex = tabItems.length - 1;
              } else {
                const step = event.key === 'ArrowRight' ? 1 : -1;
                nextIndex =
                  currentIndex === -1 ? 0 : (currentIndex + step + tabItems.length) % tabItems.length;
              }
              const nextTab = tabItems[nextIndex]!;
              selectTab(nextTab.id);
              const tabButton = event.currentTarget.querySelector<HTMLButtonElement>(
                `[data-tab="${CSS.escape(nextTab.id)}"]`,
              );
              tabButton?.focus();
              tabButton?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
          >
            {tabItems.map((item) => {
              const isActive = effectiveTab === item.id;
              return (
                <Button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  data-tab={item.id}
                  size="xs"
                  variant={isActive ? 'default' : 'ghost'}
                  title={`${item.label} (${item.count})`}
                  onClick={() => selectTab(item.id)}
                  className={cn('shrink-0', !isActive && 'text-muted-foreground')}
                >
                  {item.id === 'favorites' && <Star />}
                  {item.id === 'all' ? `All (${item.count})` : item.label}
                </Button>
              );
            })}
          </div>
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Models"
            className={cn(
              'min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin',
              activeProviderId === null ? 'scroll-pt-8' : 'scroll-pt-1.5',
            )}
          >
            {loadingModels && models.length === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">Loading available models…</p>
            )}
            {!loadingModels && groupedModels.length === 0 && (
              <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
                {effectiveTab === 'favorites' ? (
                  <p>No favorite models yet. Click the star next to any model to pin it here.</p>
                ) : models.length === 0 ? (
                  <div className="space-y-2">
                    <p>No models loaded yet. Connect an AI provider in Settings to see its models.</p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setOpen(false);
                        onOpenSettings();
                      }}
                    >
                      Connect a provider
                    </Button>
                  </div>
                ) : activeProviderId !== null ? (
                  <div className="space-y-1">
                    <p>
                      No models match “{query}” in {providerLabels.get(activeProviderId) ?? activeProviderId}.
                    </p>
                    <Button type="button" variant="link" size="xs" onClick={() => selectTab('all')}>
                      Search all providers
                    </Button>
                  </div>
                ) : (
                  <p>No models match “{query}”.</p>
                )}
              </div>
            )}
            {groupedModels.map(([provider, list]) => (
              <div key={provider} className="mb-2 last:mb-0">
                {activeProviderId === null && (
                  <div className="sticky top-0 z-10 bg-popover/95 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                    {providerLabels.get(provider) ?? provider}
                  </div>
                )}
                <ul className="space-y-px">
                  {list.map((model) => {
                    const isCurrent = model.provider === config.providerId && model.id === config.modelId;
                    const favKey = `${model.provider}/${model.id}`;
                    const flatIndex = itemIndexByKey.get(favKey) ?? -1;
                    const isActive = flatIndex !== -1 && flatIndex === activeIndex;
                    const isFav = favoriteSet.has(favKey) || favoriteSet.has(model.id);
                    const ctx = formatContextWindow(model.contextWindow);
                    return (
                      <li key={favKey} className="flex items-center gap-1">
                        <Tooltip delayDuration={350}>
                          <TooltipTrigger asChild>
                            <button
                              id={flatIndex >= 0 ? `${listboxId}-opt-${flatIndex}` : undefined}
                              type="button"
                              role="option"
                              aria-selected={isActive}
                              data-active={isActive ? 'true' : undefined}
                              onPointerMove={(event) => {
                                if (event.pointerType === 'mouse' && activeKey !== favKey) setActiveKey(favKey);
                              }}
                              onClick={() => {
                                onSelectModel(model.provider, model.id);
                                setOpen(false);
                                setQuery('');
                              }}
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors focus-visible:bg-accent',
                                isActive && 'bg-accent text-accent-foreground ring-1 ring-inset ring-foreground/10',
                                isCurrent && 'font-medium',
                              )}
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block truncate font-mono">{model.id}</span>
                                {model.name && model.name !== model.id && (
                                  <span className="block truncate text-xs text-muted-foreground">{model.name}</span>
                                )}
                              </span>
                              {ctx && (
                                <Badge variant="secondary" className="shrink-0 font-mono">
                                  {ctx}
                                </Badge>
                              )}
                              {isCurrent && <Check className="h-3.5 w-3.5 shrink-0" />}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right" align="start" sideOffset={10} className="w-64 text-xs">
                            <ModelDetails
                              model={model}
                              providerLabel={providerLabels.get(model.provider) ?? model.provider}
                            />
                          </TooltipContent>
                        </Tooltip>
                        {onToggleFavorite && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label={isFav ? `Remove ${model.id} from favorites` : `Favorite ${model.id}`}
                            onClick={() => onToggleFavorite(favKey)}
                            className={isFav ? 'text-amber-500' : 'text-muted-foreground'}
                          >
                            <Star className={isFav ? 'fill-current' : ''} />
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {trimmedQuery && !exactInList && (() => {
              const customIndex = itemIndexByKey.get('__custom__') ?? -1;
              const isCustomActive = customIndex !== -1 && customIndex === activeIndex;
              return (
                <div className="mt-1.5 border-t pt-1.5">
                  <button
                    id={customIndex >= 0 ? `${listboxId}-opt-${customIndex}` : undefined}
                    type="button"
                    role="option"
                    aria-selected={isCustomActive}
                    data-active={isCustomActive ? 'true' : undefined}
                    onPointerMove={(event) => {
                      if (event.pointerType === 'mouse' && activeKey !== '__custom__') setActiveKey('__custom__');
                    }}
                    onClick={pickCustom}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none focus-visible:bg-accent',
                      isCustomActive && 'bg-accent text-accent-foreground ring-1 ring-inset ring-foreground/10',
                    )}
                  >
                    <span>
                      Use custom model ID <code className="font-mono font-semibold">{trimmedQuery}</code>
                    </span>
                  </button>
                </div>
              );
            })()}
          </div>
          <div className="border-t px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span id="term2-effort-label" className="font-medium">
                Reasoning effort
              </span>
              <span className="truncate text-muted-foreground">{currentEffortMeta?.hint}</span>
            </div>
            <div
              role="radiogroup"
              aria-labelledby="term2-effort-label"
              className="mt-1.5 grid grid-cols-5 gap-0.5 rounded-lg bg-muted p-0.5"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const index = PICKER_LEVELS.findIndex((level) => level.value === effortValue);
                const step = event.key === 'ArrowRight' ? 1 : -1;
                const next =
                  index === -1
                    ? PICKER_LEVELS[0]!
                    : PICKER_LEVELS[(index + step + PICKER_LEVELS.length) % PICKER_LEVELS.length]!;
                onSelectEffort(next.value);
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-effort="${next.value}"]`)?.focus();
              }}
            >
              {PICKER_LEVELS.map((level, levelIndex) => {
                const selected = level.value === effortValue;
                return (
                  <button
                    key={level.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={level.label}
                    data-effort={level.value}
                    tabIndex={selected || (!effortOffered && levelIndex === 0) ? 0 : -1}
                    title={`${level.label}: ${level.hint}`}
                    disabled={disabled || busy}
                    onClick={() => {
                      if (!selected) onSelectEffort(level.value);
                    }}
                    className={cn(
                      'rounded-md py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
                      selected && 'bg-background font-medium text-foreground shadow-sm',
                    )}
                  >
                    {EFFORT_SHORT_LABELS[level.value] ?? level.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs">
            <span className="text-muted-foreground">↑↓ navigate · ↵ select</span>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Manage providers
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
