'use client';
import type { WorkspaceAlias } from '../../lib/term2/types';

export function Term2WorkspacePicker({
  workspaces,
  selected,
  loading,
  onSelect,
  onRefresh,
}: {
  workspaces: WorkspaceAlias[];
  selected: string | null;
  loading?: boolean;
  onSelect: (workspaceId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section
      aria-labelledby="term2-workspace-heading"
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 id="term2-workspace-heading" className="font-semibold">
          Workspaces
        </h2>
        <button type="button" className="text-xs underline" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {loading && <p className="text-sm text-zinc-500">Loading workspaces…</p>}
      {!loading && workspaces.length === 0 && <p className="text-sm text-zinc-500">No authorized workspaces.</p>}
      <ul className="space-y-2">
        {workspaces.map((workspace) => (
          <li key={workspace.workspaceId}>
            <button
              type="button"
              aria-pressed={selected === workspace.workspaceId}
              className={`w-full rounded-lg border p-3 text-left ${
                selected === workspace.workspaceId
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-zinc-200 dark:border-zinc-700'
              }`}
              onClick={() => onSelect(workspace.workspaceId)}
            >
              <span className="block font-medium">{workspace.label}</span>
              <span className="text-xs text-zinc-500">
                {workspace.access === 'read_write' ? 'Read and write' : 'Read only'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
