'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Shield, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
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
    hint: 'Prompt for your approval before running gated tools.',
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
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirmAlways(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setConfirmAlways(false);
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = APPROVAL_MODES.find((item) => item.value === mode) ?? APPROVAL_MODES[0];

  const toneClass =
    mode === 'always'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 hover:bg-amber-500/15 dark:border-amber-400/35 dark:bg-amber-500/15 dark:text-amber-200'
      : mode === 'auto'
        ? 'border-teal-500/35 bg-teal-500/[0.08] text-teal-800 hover:bg-teal-500/15 dark:border-teal-400/30 dark:bg-teal-500/15 dark:text-teal-200'
        : mode === 'unattended'
          ? 'border-sky-500/35 bg-sky-500/[0.08] text-sky-800 hover:bg-sky-500/15 dark:border-sky-400/30 dark:bg-sky-500/15 dark:text-sky-200'
          : 'border-black/[0.08] bg-zinc-50/70 text-zinc-600 hover:border-black/[0.16] hover:bg-zinc-100 dark:border-white/10 dark:bg-white/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.08]';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Approval mode: ${current.label}`}
        title={`Approval mode: ${current.label} — click to change`}
        onClick={() => {
          setOpen((cur) => !cur);
          setConfirmAlways(false);
        }}
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
      >
        {busy ? (
          <Loader2 aria-hidden className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ModeIcon mode={mode} className="h-3 w-3 shrink-0" />
        )}
        <span>{current.shortLabel}</span>
        <ChevronDown aria-hidden className="h-3 w-3 shrink-0 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Select approval mode"
          className="t2-enter absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border border-black/[0.09] bg-white p-1.5 shadow-[0_14px_36px_-8px_rgba(0,0,0,0.22)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_14px_36px_-8px_rgba(0,0,0,0.7)]"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-medium text-zinc-400 dark:text-zinc-500">
            Tool approval mode
          </p>

          {confirmAlways ? (
            <div className="space-y-2.5 rounded-lg border border-amber-300/70 bg-amber-50/70 p-2.5 text-xs text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
              <p className="font-semibold">Auto-approve all tools in this chat?</p>
              <p className="text-[11.5px] leading-4 opacity-90">
                Eligible file and command tools will run without asking for confirmation. Questions still require your
                answer.
              </p>
              <div className="flex justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmAlways(false)}
                  className="rounded-md border border-amber-400/60 px-2.5 py-1 text-[11.5px] font-medium hover:bg-amber-100/70 dark:border-amber-700 dark:hover:bg-amber-900/40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmAlways(false);
                    setOpen(false);
                    onSelect('always');
                  }}
                  className="rounded-md bg-amber-600 px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-amber-700"
                >
                  Enable Always
                </button>
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
                  className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active
                      ? 'bg-teal-500/10 text-teal-900 dark:bg-teal-500/15 dark:text-teal-200'
                      : 'text-zinc-800 hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <ModeIcon
                    mode={item.value}
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      item.caution
                        ? 'text-amber-600 dark:text-amber-400'
                        : active
                          ? 'text-teal-600 dark:text-teal-400'
                          : 'text-zinc-400'
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium">{item.label}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                      {item.hint}
                    </span>
                  </span>
                  {active && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
