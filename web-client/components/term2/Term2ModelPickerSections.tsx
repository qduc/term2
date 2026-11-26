'use client';

import { memo } from 'react';
import { Check, Minus, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ModelSummary, SessionConfigUpdate } from '../../lib/term2/types';

export type PickerTab = 'all' | 'favorites' | `provider:${string}`;

export interface ProviderTabItem {
  id: PickerTab;
  label: string;
  count: number;
}

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

export function formatContextWindow(tokens?: number): string | null {
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
export function ModelDetails({ model, providerLabel }: { model: ModelSummary; providerLabel: string }) {
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

export function EffortBars({ effort, label }: { effort: string; label: string }) {
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

/** Horizontally scrollable provider filter tablist with Left/Right/Home/End keyboard navigation. */
export function ProviderTabBar({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: readonly ProviderTabItem[];
  activeTab: PickerTab;
  onSelectTab: (tab: PickerTab) => void;
}) {
  return (
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
        if (tabs.length === 0) return;
        event.preventDefault();
        const currentIndex = tabs.findIndex((item) => item.id === activeTab);
        let nextIndex = 0;
        if (event.key === 'Home') {
          nextIndex = 0;
        } else if (event.key === 'End') {
          nextIndex = tabs.length - 1;
        } else {
          const step = event.key === 'ArrowRight' ? 1 : -1;
          nextIndex = currentIndex === -1 ? 0 : (currentIndex + step + tabs.length) % tabs.length;
        }
        const nextTab = tabs[nextIndex]!;
        onSelectTab(nextTab.id);
        const tabButton = event.currentTarget.querySelector<HTMLButtonElement>(
          `[data-tab="${CSS.escape(nextTab.id)}"]`,
        );
        tabButton?.focus();
        tabButton?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }}
    >
      {tabs.map((item) => {
        const isActive = activeTab === item.id;
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
            onClick={() => onSelectTab(item.id)}
            className={cn('shrink-0', !isActive && 'text-muted-foreground')}
          >
            {item.id === 'favorites' && <Star />}
            {item.id === 'all' ? `All (${item.count})` : item.label}
          </Button>
        );
      })}
    </div>
  );
}

/** One selectable model row with hover tooltip details and favorite toggle. */
export const ModelOptionRow = memo(function ModelOptionRow({
  model,
  favKey,
  providerLabel,
  optionId,
  ariaSetSize,
  ariaPosInSet,
  isCurrent,
  isActive,
  isFav,
  onHoverKey,
  onSelectModel,
  onToggleFavorite,
}: {
  model: ModelSummary;
  favKey: string;
  providerLabel: string;
  optionId?: string;
  ariaSetSize?: number;
  ariaPosInSet?: number;
  isCurrent: boolean;
  isActive: boolean;
  isFav: boolean;
  onHoverKey: (key: string) => void;
  onSelectModel: (provider: string, modelId: string) => void;
  onToggleFavorite?: (key: string) => void;
}) {
  const ctx = formatContextWindow(model.contextWindow);
  return (
    <div className="flex w-full items-center gap-1">
      <Tooltip delayDuration={350}>
        <TooltipTrigger asChild>
          <button
            id={optionId}
            type="button"
            role="option"
            aria-selected={isActive}
            aria-setsize={ariaSetSize}
            aria-posinset={ariaPosInSet}
            data-active={isActive ? 'true' : undefined}
            onPointerMove={(event) => {
              if (event.pointerType === 'mouse') onHoverKey(favKey);
            }}
            onClick={() => onSelectModel(model.provider, model.id)}
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
          <ModelDetails model={model} providerLabel={providerLabel} />
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
    </div>
  );
});

/** Segmented reasoning-effort selector with Left/Right keyboard navigation. */
export function ReasoningEffortSection({
  effortValue,
  disabled,
  busy,
  onSelectEffort,
}: {
  effortValue: string;
  disabled: boolean;
  busy: boolean;
  onSelectEffort: (effort: NonNullable<SessionConfigUpdate['reasoningEffort']>) => void;
}) {
  const currentEffortMeta = REASONING_LEVELS.find((item) => item.value === effortValue);
  const effortOffered = PICKER_LEVELS.some((level) => level.value === effortValue);
  return (
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
  );
}
