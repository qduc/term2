'use client';

import { useState, type ReactNode } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** Modal shell for the folder, settings, help and rewind flows. Mounted only while open. */
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
  // There is no DialogTrigger, so Radix has nothing to refocus on close; return focus to the opener.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener?.isConnected) opener.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Fields that use Escape to cancel an inline edit opt out of closing the dialog.
          if ((event.target as Element | null)?.closest?.('[data-escape-cancels-edit]')) event.preventDefault();
        }}
        className={cn('flex max-h-[90dvh] flex-col gap-0 p-0', wide ? 'sm:max-w-2xl' : 'sm:max-w-xl')}
      >
        <DialogHeader className="shrink-0 border-b px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin sm:px-6 sm:py-5">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
