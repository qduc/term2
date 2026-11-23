'use client';

import { useEffect, useRef, type ReactNode } from 'react';

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
    dialogRef.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="term2-setup-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] ${
        wide ? 'max-w-2xl' : 'max-w-xl'
      } overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-4 text-zinc-900 shadow-xl backdrop:bg-black/45 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="term2-setup-title" className="text-lg font-semibold">
          {title}
        </h2>
        <form method="dialog">
          <button
            type="submit"
            className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-white/[0.06]"
          >
            Close
          </button>
        </form>
      </div>
      {children}
    </dialog>
  );
}
