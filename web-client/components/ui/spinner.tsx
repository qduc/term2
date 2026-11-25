'use client';

import { cn } from '@/lib/utils';

/**
 * Pure-CSS border-ring spinner. Rotating a CSS border stays on the compositor
 * (~2.3x less renderer CPU/energy than rotating an inline SVG like Lucide Loader2).
 */
export function Spinner({
  className,
  'aria-label': ariaLabel,
}: {
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <span
      role={ariaLabel ? 'status' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn(
        't2-spinner inline-block size-3.5 shrink-0 animate-spin rounded-full border-[1.75px] border-current border-t-transparent',
        className,
      )}
    />
  );
}
