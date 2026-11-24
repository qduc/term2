'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Term2SetupDialog({
  title,
  onClose,
  wide = false,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (!el.open) {
      try {
        el.showModal();
      } catch {
        el.setAttribute('open', '');
      }
    }
    return () => {
      if (el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="term2-setup-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] ${
        wide ? 'max-w-2xl' : 'max-w-xl'
      } overflow-hidden rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/45 backdrop:backdrop-blur-[2px] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <div className="flex max-h-[90dvh] flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/[0.06] px-5 py-3.5 dark:border-white/[0.08]">
          <h2 id="term2-setup-title" className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin sm:px-6 sm:py-5">{children}</div>
      </div>
    </dialog>
  );
}
