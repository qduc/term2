'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, RefreshCw, Search, Sparkles, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

  const setMenu = (menu: 'model' | 'effort') => (open: boolean) => setOpenMenu(open ? menu : null);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Popover open={openMenu === 'model'} onOpenChange={setMenu('model')}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled || busy}
            aria-label="Choose model"
            title={`Model: ${config.providerId}/${config.modelId} (click to switch)`}
            className="max-w-[14rem] rounded-full font-mono"
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" /> : null}
            <span className="truncate">{config.modelId}</span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Select model"
          className="flex max-h-[26rem] w-[min(23rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0"
        >
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
                setOpenMenu(null);
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
                        setOpenMenu(null);
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
                        <button
                          type="button"
                          onClick={() => {
                            onSelectModel(model.provider, model.id);
                            setOpenMenu(null);
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
        </PopoverContent>
      </Popover>

      <DropdownMenu modal={false} open={openMenu === 'effort'} onOpenChange={setMenu('effort')}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled || busy}
            aria-label="Reasoning effort"
            title={`Reasoning effort: ${currentEffortMeta.label}`}
            className="rounded-full"
          >
            <Sparkles aria-hidden />
            <span>{currentEffortMeta.label}</span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" aria-label="Select reasoning effort" className="w-60">
          <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={config.reasoningEffort}
            onValueChange={(value) => onSelectEffort(value as NonNullable<SessionConfigUpdate['reasoningEffort']>)}
          >
            {REASONING_LEVELS.map((level) => (
              <DropdownMenuRadioItem key={level.value} value={level.value} className="items-start">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{level.label}</span>
                  <span className="block text-xs text-muted-foreground">{level.hint}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
