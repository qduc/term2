'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ModelSummary } from '../../../lib/term2/types';

export type ModelChoice = { provider: string; model: string };
export type PoolEntry = ModelChoice & { reasoningEffort?: string };

/** A list of removable chips with an optional add control after them. */
function ChipList({
  chips,
  empty,
  disabled,
  onRemove,
  add,
}: {
  chips: { key: string; label: ReactNode; title?: string }[];
  empty: string;
  disabled?: boolean;
  onRemove?: (index: number) => void;
  add?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.length === 0 && <span className="text-sm text-muted-foreground">{empty}</span>}
      {chips.map((chip, index) => (
        <span
          key={chip.key}
          title={chip.title}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1 text-sm"
        >
          <span className="min-w-0 truncate">{chip.label}</span>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${typeof chip.label === 'string' ? chip.label : chip.key}`}
              disabled={disabled}
              onClick={() => onRemove(index)}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <X className="size-3.5" />
            </button>
          )}
        </span>
      ))}
      {add}
    </div>
  );
}

/** "Add model" button opening a searchable list of the models term2 can use. */
export function AddModelButton({
  models,
  providerLabel,
  exclude,
  disabled,
  label = 'Add model',
  onPick,
}: {
  models: ModelSummary[];
  providerLabel: (id: string) => string;
  exclude?: (choice: ModelChoice) => boolean;
  disabled?: boolean;
  label?: string;
  onPick: (choice: ModelChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return models
      .filter((entry) => !exclude?.({ provider: entry.provider, model: entry.id }))
      .filter((entry) => {
        const haystack = `${providerLabel(entry.provider)} ${entry.provider} ${entry.id} ${entry.name ?? ''}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .slice(0, 60);
  }, [models, query, exclude, providerLabel]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="xs" disabled={disabled || models.length === 0}>
          <Plus />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <Input
          autoFocus
          value={query}
          placeholder="Search models"
          aria-label="Search models"
          onChange={(event) => setQuery(event.target.value)}
          className="h-8"
        />
        <ul className="mt-2 max-h-64 overflow-y-auto" role="listbox" aria-label="Models">
          {matches.length === 0 && <li className="px-2 py-1.5 text-sm text-muted-foreground">No matching models</li>}
          {matches.map((entry) => (
            <li key={`${entry.provider}/${entry.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onPick({ provider: entry.provider, model: entry.id });
                  setOpen(false);
                  setQuery('');
                }}
                className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-muted"
              >
                <span className="truncate text-sm">{entry.name ?? entry.id}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {providerLabel(entry.provider)} · {entry.id}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

const choiceLabel = (choice: ModelChoice, providerLabel: (id: string) => string) =>
  `${providerLabel(choice.provider)} · ${choice.model}`;

/** An ordered pool of models (helper tiers, mentor models). Entries keep any per-entry effort. */
export function ModelPoolControl({
  value,
  max,
  empty,
  models,
  providerLabel,
  disabled,
  onChange,
}: {
  value: unknown;
  max: number;
  empty: string;
  models: ModelSummary[];
  providerLabel: (id: string) => string;
  disabled?: boolean;
  onChange: (next: PoolEntry[]) => void;
}) {
  const pool: PoolEntry[] = Array.isArray(value)
    ? value.filter((item): item is PoolEntry => Boolean(item) && typeof item === 'object' && 'model' in item)
    : [];
  return (
    <ChipList
      chips={pool.map((entry) => ({
        key: `${entry.provider}/${entry.model}`,
        label: choiceLabel(entry, providerLabel),
        title: entry.reasoningEffort ? `Reasoning effort: ${entry.reasoningEffort}` : undefined,
      }))}
      empty={empty}
      disabled={disabled}
      onRemove={(index) => onChange(pool.filter((_, at) => at !== index))}
      add={
        pool.length < max && (
          <AddModelButton
            models={models}
            providerLabel={providerLabel}
            disabled={disabled}
            exclude={(choice) => pool.some((entry) => entry.provider === choice.provider && entry.model === choice.model)}
            onPick={(choice) => onChange([...pool, choice])}
          />
        )
      }
    />
  );
}

/** Favorite models, stored as "provider/modelId" strings. */
export function FavoriteModelsControl({
  value,
  models,
  providerLabel,
  disabled,
  onChange,
}: {
  value: unknown;
  models: ModelSummary[];
  providerLabel: (id: string) => string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const favorites = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const split = (entry: string): ModelChoice => {
    const at = entry.indexOf('/');
    return at > 0 ? { provider: entry.slice(0, at), model: entry.slice(at + 1) } : { provider: '', model: entry };
  };
  return (
    <ChipList
      chips={favorites.map((entry) => {
        const choice = split(entry);
        return { key: entry, label: choice.provider ? choiceLabel(choice, providerLabel) : entry };
      })}
      empty="No favorites yet."
      disabled={disabled}
      onRemove={(index) => onChange(favorites.filter((_, at) => at !== index))}
      add={
        <AddModelButton
          models={models}
          providerLabel={providerLabel}
          disabled={disabled}
          label="Add favorite"
          exclude={(choice) => favorites.includes(`${choice.provider}/${choice.model}`)}
          onPick={(choice) => onChange([...favorites, `${choice.provider}/${choice.model}`])}
        />
      }
    />
  );
}

/** Folders granted Docker control. The web can only take a grant away. */
export function RevokeListControl({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const entries = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return (
    <ChipList
      chips={entries.map((entry) => ({ key: entry, label: <span className="font-mono text-xs">{entry}</span>, title: entry }))}
      empty="No folders have Docker access."
      disabled={disabled}
      onRemove={(index) => onChange(entries.filter((_, at) => at !== index))}
    />
  );
}

/** Nicknames: a short name that stands for "provider/modelId" (with an optional ":effort"). */
export function NicknamesControl({
  value,
  models,
  providerLabel,
  disabled,
  onChange,
}: {
  value: unknown;
  models: ModelSummary[];
  providerLabel: (id: string) => string;
  disabled?: boolean;
  onChange: (next: Record<string, string>) => void;
}) {
  const nicknames =
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const nameError = /\s/.test(trimmed) ? 'Use one word.' : trimmed in nicknames ? 'That nickname is taken.' : null;
  return (
    <div className="space-y-2">
      <ChipList
        chips={Object.entries(nicknames).map(([nick, target]) => ({
          key: nick,
          label: (
            <>
              <span className="font-medium">{nick}</span>
              <span className="text-muted-foreground"> → {target}</span>
            </>
          ),
          title: `${nick} → ${target}`,
        }))}
        empty="No nicknames yet."
        disabled={disabled}
        onRemove={(index) => {
          const nick = Object.keys(nicknames)[index];
          onChange(Object.fromEntries(Object.entries(nicknames).filter(([key]) => key !== nick)));
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          disabled={disabled}
          placeholder="New nickname"
          aria-label="New nickname"
          onChange={(event) => setName(event.target.value)}
          className="h-7 w-40 text-sm"
        />
        <AddModelButton
          models={models}
          providerLabel={providerLabel}
          disabled={disabled || !trimmed || Boolean(nameError)}
          label="Choose model"
          onPick={(choice) => {
            onChange({ ...nicknames, [trimmed]: `${choice.provider}/${choice.model}` });
            setName('');
          }}
        />
        {trimmed && nameError && <span className="text-xs text-destructive">{nameError}</span>}
      </div>
    </div>
  );
}
