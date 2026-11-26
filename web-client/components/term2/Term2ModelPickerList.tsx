'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ModelSummary } from '../../lib/term2/types';
import { ModelOptionRow, type PickerTab } from './Term2ModelPickerSections';

export type SelectableModelItem =
  | { kind: 'model'; key: string; model: ModelSummary }
  | { kind: 'custom'; key: '__custom__'; query: string };

export type VirtualModelRow =
  | {
      kind: 'header';
      key: string;
      provider: string;
      label: string;
      top: number;
      height: number;
      headerTop: number;
    }
  | {
      kind: 'model';
      key: string;
      model: ModelSummary;
      providerLabel: string;
      flatIndex: number;
      top: number;
      height: number;
    }
  | {
      kind: 'custom';
      key: '__custom__';
      query: string;
      flatIndex: number;
      top: number;
      height: number;
    };

export interface VirtualModelLayout {
  rows: VirtualModelRow[];
  headers: Extract<VirtualModelRow, { kind: 'header' }>[];
  selectableItems: SelectableModelItem[];
  selectableRowByIndex: VirtualModelRow[];
  totalHeight: number;
}

const LIST_PADDING_Y = 6;
const HEADER_HEIGHT = 24;
const GROUP_GAP = 8;
const SINGLE_LINE_ROW_HEIGHT = 30;
const TWO_LINE_ROW_HEIGHT = 45;
const CUSTOM_ROW_HEIGHT = 42;
const DEFAULT_VIEWPORT_HEIGHT = 272;
const OVERSCAN_PX = 160;

export function buildVirtualModelLayout(
  groupedModels: ReadonlyArray<readonly [string, readonly ModelSummary[]]>,
  showGroupHeaders: boolean,
  providerLabels: ReadonlyMap<string, string>,
  customQuery: string | null,
): VirtualModelLayout {
  const rows: VirtualModelRow[] = [];
  const headers: Extract<VirtualModelRow, { kind: 'header' }>[] = [];
  const selectableItems: SelectableModelItem[] = [];
  const selectableRowByIndex: VirtualModelRow[] = [];
  let y = LIST_PADDING_Y;

  groupedModels.forEach(([provider, list], groupIdx) => {
    const label = providerLabels.get(provider) ?? provider;
    if (showGroupHeaders) {
      const gap = groupIdx === 0 ? 0 : GROUP_GAP;
      const height = gap + HEADER_HEIGHT;
      const headerRow: Extract<VirtualModelRow, { kind: 'header' }> = {
        kind: 'header',
        key: `__header__:${provider}`,
        provider,
        label,
        top: y,
        height,
        headerTop: y + gap,
      };
      rows.push(headerRow);
      headers.push(headerRow);
      y += height;
    }
    for (const model of list) {
      const flatIndex = selectableItems.length;
      const key = `${model.provider}/${model.id}`;
      const hasSubtitle = Boolean(model.name && model.name !== model.id);
      const height = hasSubtitle ? TWO_LINE_ROW_HEIGHT : SINGLE_LINE_ROW_HEIGHT;
      const row: Extract<VirtualModelRow, { kind: 'model' }> = {
        kind: 'model',
        key,
        model,
        providerLabel: label,
        flatIndex,
        top: y,
        height,
      };
      selectableItems.push({ kind: 'model', key, model });
      rows.push(row);
      selectableRowByIndex.push(row);
      y += height;
    }
  });

  if (customQuery) {
    const flatIndex = selectableItems.length;
    const row: Extract<VirtualModelRow, { kind: 'custom' }> = {
      kind: 'custom',
      key: '__custom__',
      query: customQuery,
      flatIndex,
      top: y,
      height: CUSTOM_ROW_HEIGHT,
    };
    selectableItems.push({ kind: 'custom', key: '__custom__', query: customQuery });
    rows.push(row);
    selectableRowByIndex.push(row);
    y += CUSTOM_ROW_HEIGHT;
  }

  return {
    rows,
    headers,
    selectableItems,
    selectableRowByIndex,
    totalHeight: rows.length > 0 ? y + LIST_PADDING_Y : 0,
  };
}

function computeScrollTarget(
  row: { top: number; height: number } | undefined,
  mode: 'center' | 'nearest',
  currentScrollTop: number,
  viewportHeight: number,
  totalHeight: number,
  topClearance: number,
): number {
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  if (!row) return 0;
  if (mode === 'center') {
    return Math.min(maxScroll, Math.max(0, row.top - (viewportHeight - row.height) / 2));
  }
  const viewTop = currentScrollTop + topClearance;
  const viewBottom = currentScrollTop + viewportHeight;
  if (row.top < viewTop) {
    return Math.min(maxScroll, Math.max(0, row.top - topClearance));
  }
  if (row.top + row.height > viewBottom) {
    return Math.min(maxScroll, Math.max(0, row.top + row.height - viewportHeight));
  }
  return Math.min(maxScroll, Math.max(0, currentScrollTop));
}

function findFirstVisibleIndex(rows: readonly VirtualModelRow[], minY: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const row = rows[mid]!;
    if (row.top + row.height <= minY) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Windowed model listbox with deterministic row offsets and a sticky provider header. */
export function VirtualModelList({
  listboxId,
  layout,
  activeIndex,
  scrollRequest,
  currentProviderId,
  currentModelId,
  favoriteSet,
  loadingModels,
  totalModelCount,
  hasGroupedModels,
  effectiveTab,
  activeProviderId,
  query,
  providerLabels,
  onSelectTab,
  onHoverKey,
  onSelectModel,
  onPickCustom,
  onToggleFavorite,
  onConnectProvider,
}: {
  listboxId: string;
  layout: VirtualModelLayout;
  activeIndex: number;
  scrollRequest: { tick: number; mode: 'center' | 'nearest' };
  currentProviderId: string;
  currentModelId: string;
  favoriteSet: ReadonlySet<string>;
  loadingModels: boolean;
  totalModelCount: number;
  hasGroupedModels: boolean;
  effectiveTab: PickerTab;
  activeProviderId: string | null;
  query: string;
  providerLabels: ReadonlyMap<string, string>;
  onSelectTab: (tab: PickerTab) => void;
  onHoverKey: (key: string) => void;
  onSelectModel: (provider: string, modelId: string) => void;
  onPickCustom: () => void;
  onToggleFavorite?: (key: string) => void;
  onConnectProvider: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const handledTickRef = useRef(-1);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  const topClearance = activeProviderId === null ? HEADER_HEIGHT : LIST_PADDING_Y;

  // Estimate initial scrollTop on mount so the first render mounts rows around the current model immediately.
  const [scrollTop, setScrollTop] = useState(() =>
    computeScrollTarget(
      activeIndex >= 0 ? layout.selectableRowByIndex[activeIndex] : undefined,
      scrollRequest.mode,
      0,
      DEFAULT_VIEWPORT_HEIGHT,
      layout.totalHeight,
      topClearance,
    ),
  );

  // Sync actual scrollTop and measured viewport height before paint on open, tab switch, filter, or arrow keys.
  useLayoutEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const measuredHeight = container.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
    if (measuredHeight !== viewportHeight) setViewportHeight(measuredHeight);
    const maxScroll = Math.max(0, layout.totalHeight - measuredHeight);

    if (handledTickRef.current !== scrollRequest.tick && layout.rows.length > 0) {
      handledTickRef.current = scrollRequest.tick;
      const target = computeScrollTarget(
        activeIndex >= 0 ? layout.selectableRowByIndex[activeIndex] : undefined,
        scrollRequest.mode,
        container.scrollTop,
        measuredHeight,
        layout.totalHeight,
        topClearance,
      );
      container.scrollTop = target;
      setScrollTop(target);
    } else if (container.scrollTop > maxScroll) {
      container.scrollTop = maxScroll;
      setScrollTop(maxScroll);
    }
  }, [scrollRequest, layout, activeIndex, topClearance, viewportHeight]);

  useLayoutEffect(() => {
    const container = listRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = container.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
      setViewportHeight((prev) => (prev === next ? prev : next));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const clampedScrollTop = Math.min(scrollTop, Math.max(0, layout.totalHeight - viewportHeight));

  const visibleRows = useMemo(() => {
    const { rows } = layout;
    if (rows.length === 0) return [];
    const first = findFirstVisibleIndex(rows, Math.max(0, clampedScrollTop - OVERSCAN_PX));
    const maxY = clampedScrollTop + viewportHeight + OVERSCAN_PX;
    const slice: VirtualModelRow[] = [];
    for (let i = first; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (row.top >= maxY) break;
      slice.push(row);
    }
    return slice;
  }, [layout, clampedScrollTop, viewportHeight]);

  let stickyHeader: { label: string; offsetY: number } | null = null;
  if (activeProviderId === null && layout.headers.length > 0 && clampedScrollTop > layout.headers[0]!.headerTop) {
    let headerIdx = 0;
    for (let i = 1; i < layout.headers.length; i += 1) {
      if (layout.headers[i]!.headerTop <= clampedScrollTop) headerIdx = i;
      else break;
    }
    const nextHeader = layout.headers[headerIdx + 1];
    const offsetY =
      nextHeader && nextHeader.headerTop - clampedScrollTop < HEADER_HEIGHT
        ? nextHeader.headerTop - clampedScrollTop - HEADER_HEIGHT
        : 0;
    stickyHeader = { label: layout.headers[headerIdx]!.label, offsetY };
  }

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label="Models"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="relative min-h-0 flex-1 overflow-y-auto px-1.5 scrollbar-thin"
    >
      {loadingModels && totalModelCount === 0 && (
        <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">Loading available models…</p>
      )}
      {!loadingModels && !hasGroupedModels && (
        <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
          {effectiveTab === 'favorites' ? (
            <p>No favorite models yet. Click the star next to any model to pin it here.</p>
          ) : totalModelCount === 0 ? (
            <div className="space-y-2">
              <p>No models loaded yet. Connect an AI provider in Settings to see its models.</p>
              <Button type="button" size="sm" onClick={onConnectProvider}>
                Connect a provider
              </Button>
            </div>
          ) : activeProviderId !== null ? (
            <div className="space-y-1">
              <p>
                No models match “{query}” in {providerLabels.get(activeProviderId) ?? activeProviderId}.
              </p>
              <Button type="button" variant="link" size="xs" onClick={() => onSelectTab('all')}>
                Search all providers
              </Button>
            </div>
          ) : (
            <p>No models match “{query}”.</p>
          )}
        </div>
      )}
      {layout.rows.length > 0 && (
        <>
          {stickyHeader && (
            <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible">
              <div
                style={{ transform: stickyHeader.offsetY ? `translateY(${stickyHeader.offsetY}px)` : undefined }}
                className="pointer-events-auto h-6 bg-popover px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {stickyHeader.label}
              </div>
            </div>
          )}
          <div className="relative w-full" style={{ height: layout.totalHeight }}>
            {visibleRows.map((row) => {
              if (row.kind === 'header') {
                return (
                  <div
                    key={row.key}
                    style={{ transform: `translateY(${row.top}px)`, height: row.height }}
                    className="absolute inset-x-0 top-0 flex items-end"
                  >
                    <div className="h-6 w-full truncate px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {row.label}
                    </div>
                  </div>
                );
              }
              if (row.kind === 'custom') {
                const isCustomActive = row.flatIndex === activeIndex;
                return (
                  <div
                    key={row.key}
                    style={{ transform: `translateY(${row.top}px)`, height: row.height }}
                    className="absolute inset-x-0 top-0 flex items-center border-t pt-1.5"
                  >
                    <button
                      id={`${listboxId}-opt-${row.flatIndex}`}
                      type="button"
                      role="option"
                      aria-selected={isCustomActive}
                      aria-setsize={layout.selectableItems.length}
                      aria-posinset={row.flatIndex + 1}
                      data-active={isCustomActive ? 'true' : undefined}
                      onPointerMove={(event) => {
                        if (event.pointerType === 'mouse') onHoverKey('__custom__');
                      }}
                      onClick={onPickCustom}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs outline-none focus-visible:bg-accent',
                        isCustomActive && 'bg-accent text-accent-foreground ring-1 ring-inset ring-foreground/10',
                      )}
                    >
                      <span>
                        Use custom model ID <code className="font-mono font-semibold">{row.query}</code>
                      </span>
                    </button>
                  </div>
                );
              }
              const { model, key: favKey, flatIndex } = row;
              const isCurrent = model.provider === currentProviderId && model.id === currentModelId;
              return (
                <div
                  key={favKey}
                  style={{ transform: `translateY(${row.top}px)`, height: row.height }}
                  className="absolute inset-x-0 top-0 flex items-center"
                >
                  <ModelOptionRow
                    model={model}
                    favKey={favKey}
                    providerLabel={row.providerLabel}
                    optionId={`${listboxId}-opt-${flatIndex}`}
                    ariaSetSize={layout.selectableItems.length}
                    ariaPosInSet={flatIndex + 1}
                    isCurrent={isCurrent}
                    isActive={flatIndex === activeIndex}
                    isFav={favoriteSet.has(favKey) || favoriteSet.has(model.id)}
                    onHoverKey={onHoverKey}
                    onSelectModel={onSelectModel}
                    onToggleFavorite={onToggleFavorite}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
