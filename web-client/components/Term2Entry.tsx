'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { Term2SessionShell } from './term2/Term2SessionShell';
import { isTerm2UiEnabled, isTerm2LocalControlEnabled } from './term2/flags';

export { isTerm2UiEnabled, isTerm2LocalControlEnabled };

export function buildExitAgentModeUrl(pathname: string, searchParams?: { toString(): string } | null): string {
  if (!searchParams) return pathname;
  const nextParams = new URLSearchParams(searchParams.toString());
  nextParams.delete('term2');
  nextParams.delete('agentSession');
  const qs = nextParams.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function exitAgentMode(
  pathname: string,
  searchParams?: { toString(): string } | null,
  router?: { push: (url: string) => void },
  navigate?: (url: string) => void,
): string {
  const targetUrl = buildExitAgentModeUrl(pathname, searchParams);
  if (navigate) {
    navigate(targetUrl);
  } else if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
    window.location.assign(targetUrl);
  } else if (router) {
    router.push(targetUrl);
  }
  return targetUrl;
}

export function Term2Entry() {
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const enabled = isTerm2UiEnabled();
  const requested = searchParams.get('term2') === '1' || !!searchParams.get('agentSession');
  const sessionId = searchParams.get('agentSession');
  const hasLegacyConflict = !!sessionId && !!searchParams.get('c');

  const handleExit = () => {
    exitAgentMode(pathname, searchParams, router);
  };

  if (requested && (!enabled || hasLegacyConflict))
    return (
      <main className="flex min-h-dvh items-center justify-center bg-white p-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <section role="alert" className="max-w-md rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-950">
          <h1 className="font-semibold">Agent mode unavailable</h1>
          <p className="mt-2 text-sm">
            Agent mode is not available for this URL. Return to Chat to continue with a regular conversation.
          </p>
          <a
            href={buildExitAgentModeUrl(pathname, searchParams)}
            className="mt-4 inline-block rounded-lg border px-3 py-1.5 text-sm"
            onClick={(event) => {
              event.preventDefault();
              handleExit();
            }}
          >
            Return to Chat
          </a>
        </section>
      </main>
    );
  // term2-only client: there is no legacy chat surface to fall back to.
  if (!requested)
    return <Term2SessionShell initialSessionId={null} authUserId={user?.id ?? null} onExit={handleExit} />;
  return <Term2SessionShell initialSessionId={sessionId} authUserId={user?.id ?? null} onExit={handleExit} />;
}
