'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useRunningTasks } from '../Term2RunningTasksPanel';
import { useSessionView } from './ShellContext';

type RunningTasks = ReturnType<typeof useRunningTasks>;
type Counts = { readonly runningCount: number; readonly needsYouCount: number };

// One useRunningTasks call for the page: two calls would keep two sets of grace timers that could disagree.
const CountsContext = createContext<Counts>({ runningCount: 0, needsYouCount: 0 });
const ShownContext = createContext<RunningTasks['shown']>([]);

export function RunningTasksProvider({ children }: { children: ReactNode }) {
  const view = useSessionView((v) => v);
  const tasks = useRunningTasks(view);
  const counts = useMemo(
    () => ({ runningCount: tasks.runningCount, needsYouCount: tasks.needsYouCount }),
    [tasks.runningCount, tasks.needsYouCount],
  );
  return (
    <CountsContext.Provider value={counts}>
      <ShownContext.Provider value={tasks.shown}>{children}</ShownContext.Provider>
    </CountsContext.Provider>
  );
}

/** For the header's "N running" pill. */
export const useRunningTaskCounts = () => useContext(CountsContext);
/** For the running tasks panel. */
export const useShownTasks = () => useContext(ShownContext);
