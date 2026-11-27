'use client';

import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { Term2RunningTasksPanel } from '../Term2RunningTasksPanel';
import { useShownTasks } from './RunningTasksContext';
import { useChatFacts, useSessionView, useShell, useShellEnv } from './ShellContext';

/** The running tasks panel and its small-screen scrim; only the user opens or closes it. */
export function TasksPanelRegion() {
  const shell = useShell();
  const { settingsOpen } = useShellEnv();
  const visible = useChatFacts((f) => f.tasksPanelVisible);
  const shown = useShownTasks();
  const view = useSessionView((v) => v);
  const allowedActions = useStoreSelector(shell.data.settings, (s) => s.data?.capabilities?.taskActions);
  if (!visible || settingsOpen) return null;
  const close = () => shell.dispatch({ type: 'TASKS_PANEL_CLOSED' });
  return (
    <>
      <button
        type="button"
        aria-label="Close running tasks"
        className="fixed inset-0 z-[60] bg-black/30 md:hidden"
        onClick={close}
      />
      <aside
        aria-label="Running tasks"
        className="fixed inset-y-0 right-0 z-[70] w-[19rem] max-w-[85vw] bg-[#f7f7f8] shadow-2xl dark:bg-zinc-950 md:relative md:z-auto md:shadow-none"
      >
        <Term2RunningTasksPanel
          view={view}
          shown={shown}
          allowedActions={allowedActions}
          onControlTask={shell.session.controlTask}
          onClose={close}
          onGoToQuestion={() =>
            document
              .getElementById('term2-pending-interaction')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        />
      </aside>
    </>
  );
}
