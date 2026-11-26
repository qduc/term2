'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import type { ChatFacts } from '../../../lib/term2/shell/chat-facts';
import { createShellRuntime, type ShellRuntime } from '../../../lib/term2/shell/shell-runtime';
import type { ShellState } from '../../../lib/term2/shell-machine';
import type { Term2SessionView } from '../../../lib/term2/types';
import type { SettingsSectionId } from '../settings/settings-catalog';
import { PageEffects } from './PageEffects';
import { RunningTasksProvider } from './RunningTasksContext';
import { ShellFeeds } from './ShellFeeds';

/** What the page was opened with; fixed for a render, never state. */
export interface ShellEnv {
  readonly homeFolder?: string;
  /** The launcher's --allow-write. */
  readonly allowWrite: boolean;
  readonly localControlEnabled: boolean;
  /** `?settings=`, parsed; null when local control is off. */
  readonly settingsSection: SettingsSectionId | null;
  readonly settingsProvider: string | null;
  readonly settingsOpen: boolean;
}

// The context carries the runtime, which never changes, and the env: a provider re-render never re-renders a region.
const RuntimeContext = createContext<ShellRuntime | null>(null);
const EnvContext = createContext<ShellEnv | null>(null);

export function Term2ShellProvider({
  initialSessionId,
  authUserId,
  env,
  children,
}: {
  initialSessionId: string | null;
  authUserId: string | null;
  env: ShellEnv;
  children: ReactNode;
}) {
  const [runtime] = useState(() => createShellRuntime({ localControlEnabled: env.localControlEnabled }));
  useEffect(() => {
    runtime.start();
    return () => runtime.stop();
  }, [runtime]);
  return (
    <RuntimeContext.Provider value={runtime}>
      <EnvContext.Provider value={env}>
        <ShellFeeds initialSessionId={initialSessionId} authUserId={authUserId} />
        <PageEffects />
        <RunningTasksProvider>{children}</RunningTasksProvider>
      </EnvContext.Provider>
    </RuntimeContext.Provider>
  );
}

/** The page's runtime: the same object for the page's life. */
export function useShell(): ShellRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useShell outside Term2ShellProvider');
  return runtime;
}

export function useShellEnv(): ShellEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error('useShellEnv outside Term2ShellProvider');
  return env;
}

export function useShellState<T>(selector: (state: ShellState) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useStoreSelector(useShell().store, selector, isEqual);
}

export function useSessionView<T>(selector: (view: Term2SessionView) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useStoreSelector(useShell().session.view, selector, isEqual);
}

export function useChatFacts<T>(selector: (facts: ChatFacts) => T, isEqual?: (a: T, b: T) => boolean): T {
  return useStoreSelector(useShell().facts, selector, isEqual);
}

/** The launcher's --allow-write, or the saved setting that grants read and write access. */
export function useAllowWrite(): boolean {
  const { allowWrite } = useShellEnv();
  const saved = useStoreSelector(
    useShell().data.settings,
    (s) => s.data?.settings.safety.workspaceAccess === 'read_write',
  );
  return allowWrite || saved;
}
