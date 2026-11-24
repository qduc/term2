'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, RefreshCw, Search, Star, TriangleAlert } from 'lucide-react';
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
  default: 'Auto',
  none: 'Off',
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Max',
};

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
  const [tab, setTab] = useState<'all' | 'favorites'>('all');

  const favoriteSet = useMemo(() => {
    const raw = settings?.settings.safeDefaults['agent.favoriteModels']?.value;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  }, [settings]);

  const providerLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of settings?.settings.providers ?? []) map.set(p.id, p.label);
    return map;
  }, [settings]);

  const groupedModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, ModelSummary[]>();
    for (const model of models) {
      const favKey = `${model.provider}/${model.id}`;
      if (tab === 'favorites' && !favoriteSet.has(favKey) && !favoriteSet.has(model.id)) continue;
      if (needle) {
        const providerLabel = (providerLabels.get(model.provider) ?? model.provider).toLowerCase();
        const hay = `${model.id} ${model.name ?? ''} ${model.provider} ${providerLabel}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()].sort(([a], [b]) => {
      if (a === config.providerId) return -1;
      if (b === config.providerId) return 1;
      return a.localeCompare(b);
    });
  }, [models, query, tab, favoriteSet, providerLabels, config.providerId]);

  const effortValue = config.reasoningEffort || 'default';
  const currentEffortMeta = REASONING_LEVELS.find((item) => item.value === effortValue);
  const effortLabel = currentEffortMeta?.label ?? effortValue;
  const showEffortInChip = effortValue !== 'default';

  const trimmedQuery = query.trim();
  const exactInList = models.some((m) => m.id === trimmedQuery || `${m.provider}/${m.id}` === trimmedQuery);

  const pickCustom = () => {
    if (!trimmedQuery) return;
    const slash = trimmedQuery.indexOf('/');
    if (slash > 0 && slash < trimmedQuery.length - 1) {
      onSelectModel(trimmedQuery.slice(0, slash), trimmedQuery.slice(slash + 1));
    } else {
      onSelectModel(config.providerId, trimmedQuery);
    }
    setOpen(false);
    setQuery('');
  };

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
            title={`Model: ${config.providerId}/${config.modelId} · Reasoning effort: ${effortLabel}${
              pending ? ' · applies when you send your next message' : ''
            }${warning ? ` · ${warning}` : ''}`}
            className={cn(
              'max-w-[18rem] rounded-full',
              pending && 'border-dashed',
              warning && 'border-amber-500/60 text-amber-800 dark:text-amber-300',
            )}
          >
            {warning && !busy && <TriangleAlert aria-label="Model may be unavailable" className="text-amber-500" />}
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {pending && !busy && (
              <span aria-label="Pending change" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            )}
            <span className="truncate font-mono">{config.modelId}</span>
            {showEffortInChip && <span className="shrink-0 text-muted-foreground">· {effortLabel}</span>}
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Select model"
          className="flex max-h-[26rem] w-[min(23rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
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
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && trimmedQuery && !exactInList && groupedModels.length === 0) {
                  event.preventDefault();
                  pickCustom();
                }
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
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs">
            <div className="flex gap-1">
              <Button
                type="button"
                size="xs"
                variant={tab === 'all' ? 'default' : 'ghost'}
                onClick={() => setTab('all')}
              >
                All ({models.length})
              </Button>
              <Button
                type="button"
                size="xs"
                variant={tab === 'favorites' ? 'default' : 'ghost'}
                onClick={() => setTab('favorites')}
              >
                <Star />
                Favorites
              </Button>
            </div>
            <Button
              type="button"
              variant="link"
              size="xs"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              Manage providers
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
            {loadingModels && models.length === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">Loading available models…</p>
            )}
            {!loadingModels && groupedModels.length === 0 && (
              <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
                {tab === 'favorites' ? (
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
                ) : (
                  <p>No models match “{query}”.</p>
                )}
              </div>
            )}
            {groupedModels.map(([provider, list]) => (
              <div key={provider} className="mb-2 last:mb-0">
                <div className="sticky top-0 z-10 bg-popover/95 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                  {providerLabels.get(provider) ?? provider}
                </div>
                <ul className="space-y-px">
                  {list.map((model) => {
                    const isCurrent = model.provider === config.providerId && model.id === config.modelId;
                    const favKey = `${model.provider}/${model.id}`;
                    const isFav = favoriteSet.has(favKey) || favoriteSet.has(model.id);
                    const ctx = formatContextWindow(model.contextWindow);
                    return (
                      <li key={favKey} className="flex items-center gap-1">
                        <Tooltip delayDuration={350}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                onSelectModel(model.provider, model.id);
                                setOpen(false);
                                setQuery('');
                              }}
                              className={cn(
                                'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                                isCurrent && 'bg-accent font-medium text-accent-foreground',
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
            {trimmedQuery && !exactInList && (
              <div className="mt-1.5 border-t pt-1.5">
                <button
                  type="button"
                  onClick={pickCustom}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-accent focus-visible:bg-accent"
                >
                  <span>
                    Use custom model ID <code className="font-mono font-semibold">{trimmedQuery}</code>
                  </span>
                </button>
              </div>
            )}
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
              className="mt-1.5 grid grid-cols-7 gap-0.5 rounded-lg bg-muted p-0.5"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const index = REASONING_LEVELS.findIndex((level) => level.value === effortValue);
                const step = event.key === 'ArrowRight' ? 1 : -1;
                const next = REASONING_LEVELS[(index + step + REASONING_LEVELS.length) % REASONING_LEVELS.length]!;
                onSelectEffort(next.value);
                event.currentTarget.querySelector<HTMLButtonElement>(`[data-effort="${next.value}"]`)?.focus();
              }}
            >
              {REASONING_LEVELS.map((level) => {
                const selected = level.value === effortValue;
                return (
                  <button
                    key={level.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={level.label}
                    data-effort={level.value}
                    tabIndex={selected ? 0 : -1}
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
        </PopoverContent>
      </Popover>
    </div>
  );
}
