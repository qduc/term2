'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { RowStatus } from './SettingRow';
import { itemKeys, type SettingItem } from './settings-catalog';
import { groupSettingItems } from './settings-groups';

/** One line under a group heading, said once instead of under every row. */
const GROUP_NOTES: Record<string, string> = {
  'Helper models': 'Used for side tasks, so the chat’s model stays on your work.',
};

type PoolEntry = { provider?: string; model?: string };

const shortModel = (id: string) => id.slice(id.lastIndexOf('/') + 1);

/**
 * The Models section as a summary: one line per setting with the chosen models in focus.
 * Clicking a line opens its editor underneath; one editor is open at a time.
 */
export function ModelsSummary({
  items,
  value,
  providerLabel,
  isModified,
  lockedReason,
  status,
  editor,
  onCommit,
  onReset,
}: {
  items: SettingItem[];
  value: (key: string) => unknown;
  providerLabel: (id: string) => string;
  isModified: (item: SettingItem) => boolean;
  lockedReason: (item: SettingItem) => string | undefined;
  status: (item: SettingItem) => RowStatus | undefined;
  /** The full editor for list rows (models, favorites, nicknames) and the tier effort picker. */
  editor: (item: SettingItem) => ReactNode;
  onCommit: (item: SettingItem, value: unknown) => void;
  onReset: (item: SettingItem) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const groups = groupSettingItems(items);

  /** The bold part of a line, with quieter extras after it. */
  const summary = (item: SettingItem): ReactNode => {
    const stored = value(itemKeys(item)[0] ?? item.id);
    const empty = (text: string) => <span className="text-[15px] font-normal text-muted-foreground">{text}</span>;
    const more = (count: number) =>
      count > 0 ? <span className="text-sm font-normal text-muted-foreground"> · +{count} more</span> : null;
    if (item.kind === 'model-tier' || item.kind === 'model-pool') {
      const pool = Array.isArray(stored) ? (stored as PoolEntry[]).filter((entry) => entry?.model) : [];
      if (pool.length === 0) return empty(item.kind === 'model-tier' ? 'Same as the chat' : 'None');
      const [first] = pool;
      return (
        <>
          {shortModel(first!.model!)}
          {first!.provider && (
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">{providerLabel(first!.provider)}</span>
          )}
          {more(pool.length - 1)}
        </>
      );
    }
    if (item.kind === 'favorites') {
      const list = Array.isArray(stored) ? stored.filter((entry): entry is string => typeof entry === 'string') : [];
      if (list.length === 0) return empty('None');
      return (
        <>
          {list.slice(0, 2).map(shortModel).join(', ')}
          {more(list.length - 2)}
        </>
      );
    }
    if (item.kind === 'nicknames') {
      const names = stored && typeof stored === 'object' && !Array.isArray(stored) ? Object.keys(stored) : [];
      if (names.length === 0) return empty('None');
      return (
        <>
          {names.slice(0, 3).join(', ')}
          {more(names.length - 3)}
        </>
      );
    }
    if (typeof stored === 'string' && stored) return shortModel(stored);
    return empty(item.placeholder ?? 'None');
  };

  /** The tier effort, shown on the right of the line. */
  const effort = (item: SettingItem): string => {
    const key = item.kind === 'model-tier' ? itemKeys(item)[1] : undefined;
    const stored = key ? value(key) : undefined;
    if (typeof stored !== 'string' || !stored) return '';
    return item.options?.find((option) => option.value === stored)?.label ?? (stored === 'default' ? 'Model default' : stored);
  };

  const footer = (item: SettingItem) => {
    const state = status(item);
    const locked = lockedReason(item);
    return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {state?.state === 'saving' && <Loader2 aria-label="Saving" className="size-3.5 animate-spin text-muted-foreground" />}
        {state?.state === 'saved' && (
          <span role="status" className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <Check className="size-3.5" />
            Saved
          </span>
        )}
        {state?.state === 'error' && (
          <span role="alert" className="inline-flex items-center gap-1 text-destructive">
            <CircleAlert className="size-3.5" />
            {state.message}
          </span>
        )}
        {locked && <span className="text-muted-foreground">{locked}</span>}
        <span className="flex-1" />
        {isModified(item) && !locked && (
          <button
            type="button"
            onClick={() => onReset(item)}
            className="text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground"
          >
            Reset to default
          </button>
        )}
      </div>
    );
  };

  const row = (item: SettingItem) => {
    if (item.kind === 'boolean') {
      return (
        <div key={item.id} className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-4 px-2.5 py-2.5">
          <span className="text-sm text-muted-foreground">{item.label}</span>
          <span className="text-sm text-muted-foreground">{item.description}</span>
          <Switch
            aria-label={item.label}
            checked={value(item.id) === true}
            disabled={Boolean(lockedReason(item)) || status(item)?.state === 'saving'}
            onCheckedChange={(checked) => onCommit(item, checked)}
          />
        </div>
      );
    }
    const open = openId === item.id;
    const panelId = `model-setting-${item.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    return (
      <Fragment key={item.id}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpenId(open ? null : item.id)}
          className={cn(
            'grid w-full grid-cols-[7rem_minmax(0,1fr)_auto] items-center gap-4 px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60',
            open ? 'rounded-t-lg bg-muted/60' : 'rounded-lg',
          )}
        >
          <span className="text-sm text-muted-foreground">{item.label}</span>
          <span className="truncate text-[15px] font-medium text-foreground">{summary(item)}</span>
          <span className="min-w-16 text-right text-sm text-muted-foreground">{effort(item)}</span>
        </button>
        {open && (
          <div id={panelId} className="mb-1 rounded-b-lg bg-muted/60 px-2.5 pb-3.5 pt-1 sm:pl-[8.5rem]">
            <p className="mb-2.5 text-sm text-muted-foreground">{item.description}</p>
            {item.kind === 'text' ? (
              <InlineText
                value={value(item.id)}
                placeholder={item.placeholder}
                label={item.label}
                disabled={Boolean(lockedReason(item)) || status(item)?.state === 'saving'}
                onCommit={(next) => onCommit(item, next)}
              />
            ) : (
              editor(item)
            )}
            {footer(item)}
          </div>
        )}
      </Fragment>
    );
  };

  return (
    <div className="mt-2">
      {groups.map((group, index) => (
        <section key={group.name ?? index} className={index > 0 ? 'mt-7' : 'mt-5'}>
          {group.name && (
            <h3 className="mb-1.5 px-2.5 text-xs text-muted-foreground">
              <span className="font-medium uppercase tracking-wide">{group.name}</span>
              {GROUP_NOTES[group.name] && <span> · {GROUP_NOTES[group.name]}</span>}
            </h3>
          )}
          {group.items.map(row)}
        </section>
      ))}
    </div>
  );
}

/** A text value that saves on Enter or blur; clearing it resets the setting. */
function InlineText({
  value,
  placeholder,
  label,
  disabled,
  onCommit,
}: {
  value: unknown;
  placeholder?: string;
  label: string;
  disabled?: boolean;
  onCommit: (value: string | null) => void;
}) {
  const shown = typeof value === 'string' ? value : '';
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== shown) onCommit(next === '' ? null : next);
  };
  return (
    <Input
      value={draft ?? shown}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      data-escape-cancels-edit
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') setDraft(null);
      }}
      className="h-8 w-full bg-background sm:w-72"
    />
  );
}
