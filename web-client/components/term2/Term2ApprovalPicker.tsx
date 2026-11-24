'use client';

import { useState } from 'react';
import { Check, ChevronDown, Loader2, Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { SessionApprovalMode } from '../../lib/term2/types';

export const APPROVAL_MODES: ReadonlyArray<{
  value: SessionApprovalMode;
  shortLabel: string;
  label: string;
  hint: string;
  caution?: boolean;
}> = [
  {
    value: 'off',
    shortLabel: 'Ask',
    label: 'Ask before tools',
    hint: 'Prompt before gated tools. File reads of granted paths do not prompt.',
  },
  {
    value: 'auto',
    shortLabel: 'Auto',
    label: 'Smart auto-approve',
    hint: 'Auto-approve low- and medium-risk actions; ask when unsure.',
  },
  {
    value: 'unattended',
    shortLabel: 'Unattended',
    label: 'Unattended (safe only)',
    hint: 'Auto-approve safe actions and refuse risky ones without waiting.',
  },
  {
    value: 'always',
    shortLabel: 'Always',
    label: 'Auto-approve all',
    hint: 'Bypass eligible permission prompts automatically.',
    caution: true,
  },
];

function ModeIcon({ mode, className }: { mode: SessionApprovalMode; className?: string }) {
  switch (mode) {
    case 'auto':
      return <ShieldCheck aria-hidden className={className} />;
    case 'unattended':
      return <ShieldAlert aria-hidden className={className} />;
    case 'always':
      return <ShieldOff aria-hidden className={className} />;
    default:
      return <Shield aria-hidden className={className} />;
  }
}

export function Term2ApprovalPicker({
  mode,
  disabled,
  busy,
  onSelect,
}: {
  mode: SessionApprovalMode;
  disabled: boolean;
  busy: boolean;
  onSelect: (mode: SessionApprovalMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmAlways, setConfirmAlways] = useState(false);

  const current = APPROVAL_MODES.find((item) => item.value === mode) ?? APPROVAL_MODES[0];

  const toneClass =
    mode === 'always'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-200'
      : mode === 'auto'
        ? 'border-teal-500/35 bg-teal-500/[0.08] text-teal-800 hover:bg-teal-500/15 dark:border-teal-400/30 dark:bg-teal-500/15 dark:text-teal-200'
        : mode === 'unattended'
          ? 'border-sky-500/35 bg-sky-500/[0.08] text-sky-800 hover:bg-sky-500/15 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-200'
          : '';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setConfirmAlways(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled || busy}
          aria-haspopup="menu"
          aria-label={`Approval mode: ${current.label}`}
          title={`Approval mode: ${current.label} — click to change`}
          className={cn('rounded-full', toneClass)}
        >
          {busy ? <Loader2 aria-hidden className="animate-spin" /> : <ModeIcon mode={mode} />}
          <span>{current.shortLabel}</span>
          <ChevronDown aria-hidden className="opacity-60" />
        </Button>
      </PopoverTrigger>

      <PopoverContent side="top" align="start" role="menu" aria-label="Select approval mode" className="w-72 gap-0 p-1">
          <p className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
            Tool approval mode
          </p>

          {confirmAlways ? (
            <div className="space-y-2.5 rounded-lg border border-amber-300/70 bg-amber-50/70 p-2.5 text-xs text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
              <p className="font-semibold">Auto-approve all tools in this chat?</p>
              <p className="text-xs leading-4 opacity-90">
                Eligible file and command tools will run without asking for confirmation. Questions still require your
                answer.
              </p>
              <div className="flex justify-end gap-1.5 pt-1">
                <Button type="button" variant="outline" size="xs" onClick={() => setConfirmAlways(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="xs"
                  onClick={() => {
                    setConfirmAlways(false);
                    setOpen(false);
                    onSelect('always');
                  }}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                >
                  Enable Always
                </Button>
              </div>
            </div>
          ) : (
            APPROVAL_MODES.map((item) => {
              const active = mode === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    if (item.value === 'always' && mode !== 'always') {
                      setConfirmAlways(true);
                      return;
                    }
                    setOpen(false);
                    if (item.value !== mode) onSelect(item.value);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent',
                    active && 'bg-accent text-accent-foreground',
                  )}
                >
                  <ModeIcon
                    mode={item.value}
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      item.caution
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">{item.label}</span>
                    <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                      {item.hint}
                    </span>
                  </span>
                  {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })
          )}
      </PopoverContent>
    </Popover>
  );
}
