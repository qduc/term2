'use client';

import { useEffect, useState } from 'react';
import type { Resource } from '../lib/term2/data/resource';
import { useStoreSelector } from './useStoreSelector';

export type Opened<T> = {
  /** 'loading' until the request this screen started has answered. */
  readonly status: 'loading' | 'failed' | 'ready';
  /** The resource's data; meaningful when `status` is 'ready'. */
  readonly data: T;
  readonly error: string | null;
  /** Asks again and shows loading. */
  reload(): void;
};

/**
 * A screen that asks for its data each time it opens (the rewind dialog, the provider dialog, the settings page's
 * presets): it shows loading until its own request answers, never data an earlier opening read
 * (docs/plans/web-client/web-shell-decomposition-part2.md, section 3.4). The data lives in the shared resource.
 */
export function useLoadOnOpen<T>(resource: Resource<T>, key: string | null = null): Opened<T> {
  const [attempt, setAttempt] = useState(0);
  const [answered, setAnswered] = useState<{ key: string | null; attempt: number; ok: boolean } | null>(null);
  useEffect(() => {
    let current = true;
    resource.loadOrFail(key).then(
      () => current && setAnswered({ key, attempt, ok: true }),
      () => current && setAnswered({ key, attempt, ok: false }),
    );
    return () => {
      current = false;
    };
  }, [resource, key, attempt]);
  const state = useStoreSelector(resource, (s) => s);
  const settled = answered && answered.key === key && answered.attempt === attempt ? answered : null;
  return {
    status: !settled ? 'loading' : settled.ok ? 'ready' : 'failed',
    data: state.data,
    error: state.error,
    reload: () => setAttempt((n) => n + 1),
  };
}
