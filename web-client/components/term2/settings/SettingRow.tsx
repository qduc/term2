'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { fromDisplay, toDisplay, type SettingItem } from './settings-catalog';

export type RowStatus = { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };
/** 'saving' when the change is being saved now; 'confirming' when it first waits for a confirmation. */
export type CommitResult = 'saving' | 'confirming' | void;

export function controlId(id: string): string {
  return `setting-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A number in display units (seconds, percent) that saves on Enter or blur, in stored units.
 * Escape or an empty field puts the saved value back.
 */
export function NumberField({
  id,
  value,
  factor = 1,
  unit,
  min,
  max,
  step,
  integer,
  disabled,
  saving,
  label,
  onCommit,
}: {
  id: string;
  value: unknown;
  integer?: boolean;
  factor?: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: string;
  disabled?: boolean;
  saving?: boolean;
  label?: string;
  onCommit: (stored: number) => CommitResult;
}) {
  const shown = typeof value === 'number' ? String(toDisplay(value, factor)) : '';
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The typed value stays visible while it saves instead of flashing back to the old one.
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!saving) setPending(null);
  }, [saving]);

  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === '' || raw === shown) {
      setError(null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < min) || (max !== undefined && parsed > max)) {
      setError(
        min !== undefined && max !== undefined
          ? `Enter a number from ${min} to ${max}.`
          : min !== undefined
            ? `Enter a number of at least ${min}.`
            : 'Enter a number.',
      );
      return;
    }
    if (integer && factor === 1 && !Number.isInteger(parsed)) {
      setError('Enter a whole number.');
      return;
    }
    setError(null);
    // Seconds may have decimals; the stored milliseconds must still be whole.
    const stored = integer ? Math.round(fromDisplay(parsed, factor)) : fromDisplay(parsed, factor);
    if (onCommit(stored) === 'saving') setPending(raw);
  };

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={draft ?? pending ?? shown}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          data-escape-cancels-edit
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              setDraft(null);
              setError(null);
            }
          }}
          className="w-28 text-right"
        />
        {unit && <span className="min-w-16 text-sm text-muted-foreground">{unit}</span>}
      </div>
      {error && (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

/** A text value (an address) that saves on Enter or blur. Clearing it resets the setting. */
function TextField({
  id,
  value,
  disabled,
  saving,
  onCommit,
}: {
  id: string;
  value: unknown;
  disabled?: boolean;
  saving?: boolean;
  onCommit: (value: string | null) => CommitResult;
}) {
  const shown = valueText(value);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!saving) setPending(null);
  }, [saving]);
  const commit = () => {
    if (draft === null) return;
    const raw = draft.trim();
    setDraft(null);
    if (raw === shown) return;
    if (onCommit(raw === '' ? null : raw) === 'saving') setPending(raw);
  };
  return (
    <Input
      id={id}
      type="text"
      inputMode="url"
      value={draft ?? pending ?? shown}
      disabled={disabled}
      placeholder="https://"
      data-escape-cancels-edit
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') setDraft(null);
      }}
      className="w-full sm:w-64"
    />
  );
}

/** Label and description on the left, the control on the right; saves as soon as it changes. */
export function SettingRow({
  item,
  breadcrumb,
  value,
  modified,
  lockedReason,
  status,
  onCommit,
  onReset,
  control,
  below,
}: {
  item: SettingItem;
  /** "Section › Setting" path, shown in search results. */
  breadcrumb?: string;
  /** The stored value, for single-value rows. */
  value: unknown;
  modified: boolean;
  /** Why the value cannot be changed here (for example, set by an environment variable). */
  lockedReason?: string;
  status?: RowStatus;
  onCommit: (value: unknown) => CommitResult;
  onReset: () => void;
  /** Replaces the built-in control (API keys and combined controls). */
  control?: ReactNode;
  /** A follow-up control shown under the description (the compaction threshold). */
  below?: ReactNode;
}) {
  const id = controlId(item.id);
  const saving = status?.state === 'saving';
  const disabled = Boolean(lockedReason) || saving;
  const selectedHint =
    item.kind === 'select' ? item.options?.find((option) => option.value === value)?.hint : undefined;

  let input: ReactNode = control;
  if (!input && item.kind === 'boolean') {
    input = (
      <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={(checked) => onCommit(checked)} />
    );
  } else if (!input && item.kind === 'select' && item.options) {
    const current = valueText(value);
    input = (
      <Select value={current} disabled={disabled} onValueChange={(next) => onCommit(next)}>
        <SelectTrigger id={id} size="sm" className="w-full sm:w-60">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {current && !item.options.some((option) => option.value === current) && (
            <SelectItem value={current}>{current}</SelectItem>
          )}
          {item.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (!input && item.kind === 'number') {
    input = (
      <NumberField
        id={id}
        value={value}
        factor={item.factor}
        unit={item.unit}
        min={item.min}
        max={item.max}
        step={item.step}
        integer={item.integer}
        disabled={disabled}
        saving={saving}
        onCommit={(stored) => onCommit(stored)}
      />
    );
  } else if (!input) {
    input = <TextField id={id} value={value} disabled={disabled} saving={saving} onCommit={(next) => onCommit(next)} />;
  }

  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
      <div className="min-w-0 flex-1">
        {breadcrumb && <p className="mb-0.5 text-xs text-muted-foreground">{breadcrumb}</p>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label htmlFor={control ? undefined : id} className="text-sm font-medium text-foreground">
            {item.label}
          </label>
          {modified && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
              Modified
            </span>
          )}
          {saving && <Loader2 aria-label="Saving" className="size-3.5 animate-spin text-muted-foreground" />}
          {status?.state === 'saved' && (
            <span role="status" className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <Check className="size-3.5" />
              Saved
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{item.description}</p>
        {selectedHint && <p className="mt-1 text-sm text-foreground/80">{selectedHint}</p>}
        {below && <div className="mt-3">{below}</div>}
        {lockedReason && <p className="mt-1 text-xs text-muted-foreground">{lockedReason}</p>}
        {status?.state === 'error' && (
          <p role="alert" className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
            <CircleAlert className="size-3.5 shrink-0" />
            {status.message}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
        {input}
        {modified && !lockedReason && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={saving}
            onClick={onReset}
            className="text-muted-foreground"
          >
            <RotateCcw />
            Reset to default
          </Button>
        )}
      </div>
    </div>
  );
}
