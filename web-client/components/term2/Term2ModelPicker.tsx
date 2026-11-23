'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, RefreshCw, Search, Sparkles, Star } from 'lucide-react';
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

function formatContextWindow(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}k`;
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
}) {
  const [openMenu, setOpenMenu] = useState<'model' | 'effort' | null>(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'favorites'>('all');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const favoriteSet = useMemo(() => {
    const raw = settings?.settings.safeDefaults['agent.favoriteModels']?.value;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []);
  }, [settings]);

  const providerLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of settings?.settings.providers ?? []) map.set(p.id, p.label);
    return map;
  }, [settings]);

  useEffect(() => {
    if (!openMenu) return;
    if (openMenu === 'model') {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

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

  const currentEffortMeta = REASONING_LEVELS.find((item) => item.value === config.reasoningEffort) ?? {
    value: 'default',
    label: config.reasoningEffort || 'Default',
    hint: '',
  };

  const trimmedQuery = query.trim();
  const exactInList = models.some(
    (m) => m.id === trimmedQuery || `${m.provider}/${m.id}` === trimmedQuery,
  );

  const pickCustom = () => {
    if (!trimmedQuery) return;
    const slash = trimmedQuery.indexOf('/');
    if (slash > 0 && slash < trimmedQuery.length - 1) {
      onSelectModel(trimmedQuery.slice(0, slash), trimmedQuery.slice(slash + 1));
    } else {
      onSelectModel(config.providerId, trimmedQuery);
    }
    setOpenMenu(null);
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-1.5">
      <button
        type="button"
        disabled={disabled || busy}
        aria-haspopup="dialog"
        aria-expanded={openMenu === 'model'}
        aria-label="Choose model"
        title={`Model: ${config.providerId}/${config.modelId} (click to switch)`}
        onClick={() => setOpenMenu((cur) => (cur === 'model' ? null : 'model'))}
        className="inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-black/[0.08] bg-zinc-50/70 px-2.5 py-1 font-mono text-[11.5px] text-zinc-700 transition-colors hover:border-black/[0.16] hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.08]"
      >
        {busy ? (
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin text-teal-600 dark:text-teal-400" />
        ) : null}
        <span className="truncate">{config.modelId}</span>
        <ChevronDown aria-hidden className="h-3 w-3 shrink-0 text-zinc-400" />
      </button>

      <button
        type="button"
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={openMenu === 'effort'}
        aria-label="Reasoning effort"
        title={`Reasoning effort: ${currentEffortMeta.label}`}
        onClick={() => setOpenMenu((cur) => (cur === 'effort' ? null : 'effort'))}
        className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] bg-zinc-50/70 px-2.5 py-1 text-[11.5px] text-zinc-600 transition-colors hover:border-black/[0.16] hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08]"
      >
        <Sparkles aria-hidden className="h-3 w-3 shrink-0 text-teal-600 dark:text-teal-400" />
        <span>{currentEffortMeta.label}</span>
        <ChevronDown aria-hidden className="h-3 w-3 shrink-0 text-zinc-400" />
      </button>

      {openMenu === 'model' && (
        <div
          role="dialog"
          aria-label="Select model"
          className="t2-enter absolute bottom-full left-0 z-40 mb-2 flex max-h-[26rem] w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-black/[0.09] bg-white shadow-[0_16px_40px_-10px_rgba(0,0,0,0.22)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_16px_40px_-10px_rgba(0,0,0,0.7)]"
        >
          <div className="flex items-center gap-2 border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.07]">
            <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
            <input
              ref={searchRef}
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
              className="min-w-0 flex-1 bg-transparent text-xs text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 [&::-webkit-search-cancel-button]:hidden"
            />
            <button
              type="button"
              onClick={onRefreshModels}
              disabled={loadingModels}
              title="Refresh model list"
              aria-label="Refresh model list"
              className="rounded-md p-1 text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loadingModels ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="flex items-center justify-between border-b border-black/[0.05] px-3 py-1.5 text-[11.5px] dark:border-white/[0.06]">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setTab('all')}
                className={`rounded-md px-2 py-0.5 font-medium transition-colors ${
                  tab === 'all'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-black/[0.04] dark:text-zinc-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                All ({models.length})
              </button>
              <button
                type="button"
                onClick={() => setTab('favorites')}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors ${
                  tab === 'favorites'
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-black/[0.04] dark:text-zinc-400 dark:hover:bg-white/[0.06]'
                }`}
              >
                <Star className="h-3 w-3" />
                Favorites
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(null);
                onOpenSettings();
              }}
              className="text-teal-700 hover:underline dark:text-teal-400"
            >
              Manage providers
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
            {loadingModels && models.length === 0 && (
              <p className="px-2.5 py-6 text-center text-xs text-zinc-500">Loading available models…</p>
            )}
            {!loadingModels && groupedModels.length === 0 && (
              <div className="px-2.5 py-5 text-center text-xs text-zinc-500">
                {tab === 'favorites' ? (
                  <p>No favorite models yet. Click the star next to any model to pin it here.</p>
                ) : models.length === 0 ? (
                  <div className="space-y-2">
                    <p>No models loaded yet. Connect an AI provider in Settings to see its models.</p>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenu(null);
                        onOpenSettings();
                      }}
                      className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-700"
                    >
                      Connect a provider
                    </button>
                  </div>
                ) : (
                  <p>No models match “{query}”.</p>
                )}
              </div>
            )}
            {groupedModels.map(([provider, list]) => (
              <div key={provider} className="mb-2 last:mb-0">
                <div className="sticky top-0 z-10 bg-white/95 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 backdrop-blur dark:bg-zinc-900/95 dark:text-zinc-500">
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
                        <button
                          type="button"
                          onClick={() => {
                            onSelectModel(model.provider, model.id);
                            setOpenMenu(null);
                            setQuery('');
                          }}
                          className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                            isCurrent
                              ? 'bg-teal-500/10 font-medium text-teal-900 dark:bg-teal-500/15 dark:text-teal-200'
                              : 'text-zinc-800 hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
                          }`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-[12px]">{model.id}</span>
                            {model.name && model.name !== model.id && (
                              <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                                {model.name}
                              </span>
                            )}
                          </span>
                          {ctx && (
                            <span className="shrink-0 rounded bg-black/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
                              {ctx}
                            </span>
                          )}
                          {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />}
                        </button>
                        {onToggleFavorite && (
                          <button
                            type="button"
                            aria-label={isFav ? `Remove ${model.id} from favorites` : `Favorite ${model.id}`}
                            onClick={() => onToggleFavorite(favKey)}
                            className={`rounded-md p-1.5 transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.07] ${
                              isFav ? 'text-amber-500' : 'text-zinc-300 hover:text-zinc-500 dark:text-zinc-600'
                            }`}
                          >
                            <Star className={`h-3.5 w-3.5 ${isFav ? 'fill-current' : ''}`} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {trimmedQuery && !exactInList && (
              <div className="mt-1.5 border-t border-black/[0.06] pt-1.5 dark:border-white/[0.06]">
                <button
                  type="button"
                  onClick={pickCustom}
                  className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-teal-700 hover:bg-teal-500/10 dark:text-teal-400"
                >
                  <span>
                    Use custom model ID <code className="font-mono font-semibold">{trimmedQuery}</code>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {openMenu === 'effort' && (
        <div
          role="menu"
          aria-label="Select reasoning effort"
          className="t2-enter absolute bottom-full left-0 z-40 mb-2 w-60 rounded-xl border border-black/[0.09] bg-white p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.2)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.65)]"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
            Reasoning effort
          </p>
          {REASONING_LEVELS.map((level) => {
            const active = config.reasoningEffort === level.value;
            return (
              <button
                key={level.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelectEffort(level.value);
                  setOpenMenu(null);
                }}
                className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                  active
                    ? 'bg-teal-500/10 text-teal-900 dark:bg-teal-500/15 dark:text-teal-200'
                    : 'text-zinc-800 hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{level.label}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{level.hint}</span>
                </span>
                {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
