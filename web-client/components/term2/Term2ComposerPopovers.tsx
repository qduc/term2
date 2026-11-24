'use client';

import { useEffect, useRef } from 'react';
import { FileText, Folder, Sparkles, Wand2, type LucideIcon } from 'lucide-react';
import type { SkillSummary, WorkspaceFileEntry } from '../../lib/term2/types';

export interface QuickActionItem {
  id: string;
  label: string;
  hint: string;
  shortcut?: string;
  icon: LucideIcon;
  disabled?: boolean;
  run: () => void;
}

export function Term2PathPopover({
  entries,
  query,
  loading,
  activeIndex,
  onSelect,
}: {
  entries: WorkspaceFileEntry[];
  query: string;
  loading: boolean;
  activeIndex: number;
  onSelect: (entry: WorkspaceFileEntry) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Workspace files"
      className="t2-enter absolute bottom-full left-0 z-40 mb-2 max-h-64 w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-black/[0.09] bg-white p-1.5 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.2)] scrollbar-thin dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_14px_36px_-10px_rgba(0,0,0,0.65)]"
    >
      <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-zinc-400">
        <span>Mention a file {query ? `matching “${query}”` : ''}</span>
        <span>Enter or Tab to insert</span>
      </div>
      {loading && entries.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-zinc-500">Scanning folder files…</p>
      )}
      {!loading && entries.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-zinc-500">No matching files in this folder.</p>
      )}
      {entries.map((entry, index) => (
        <button
          key={entry.path}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(entry);
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
            index === activeIndex
              ? 'bg-teal-500/12 text-teal-900 dark:bg-teal-500/20 dark:text-teal-100'
              : 'text-zinc-700 hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.06]'
          }`}
        >
          {entry.type === 'directory' ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          )}
          <span className="truncate font-mono text-[12px]">
            {entry.path}
            {entry.type === 'directory' ? '/' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Term2SkillsPopover({
  skills,
  loading,
  selectedSkill,
  onSelect,
}: {
  skills: SkillSummary[];
  loading: boolean;
  selectedSkill: string | null;
  onSelect: (skill: SkillSummary | null) => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Choose a skill"
      className="t2-enter absolute bottom-full left-0 z-40 mb-2 max-h-72 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-2xl border border-black/[0.09] bg-white p-1.5 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.2)] scrollbar-thin dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_14px_36px_-10px_rgba(0,0,0,0.65)]"
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 text-[11px] text-zinc-400">
        <span className="inline-flex items-center gap-1 font-medium text-zinc-600 dark:text-zinc-300">
          <Wand2 className="h-3 w-3 text-teal-600 dark:text-teal-400" />
          Skills
        </span>
        {selectedSkill && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="text-teal-700 hover:underline dark:text-teal-400"
          >
            Clear active
          </button>
        )}
      </div>
      {loading && skills.length === 0 && <p className="px-2.5 py-3 text-xs text-zinc-500">Loading skills…</p>}
      {!loading && skills.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-zinc-500">
          No skills installed yet. Place a <code>SKILL.md</code> folder under <code>~/.term2/skills/</code> or your
          project’s <code>.agents/skills/</code>.
        </p>
      )}
      {skills.map((skill) => {
        const active = selectedSkill === skill.name;
        return (
          <button
            key={skill.name}
            type="button"
            onClick={() => onSelect(active ? null : skill)}
            className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
              active
                ? 'bg-teal-500/12 text-teal-950 dark:bg-teal-500/20 dark:text-teal-100'
                : 'text-zinc-800 hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
            }`}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="h-3 w-3 shrink-0 text-teal-600 dark:text-teal-400" />
              <span className="truncate">{skill.name}</span>
              {skill.isProjectLevel && (
                <span className="ml-auto rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-normal text-zinc-500 dark:bg-white/[0.07]">
                  Project
                </span>
              )}
            </span>
            {skill.description && (
              <span className="line-clamp-2 text-[11px] text-zinc-500 dark:text-zinc-400">{skill.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Term2QuickPalette({
  actions,
  activeIndex,
  query,
}: {
  actions: QuickActionItem[];
  activeIndex: number;
  query: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, actions]);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Quick actions"
      className="t2-enter absolute bottom-full left-0 z-50 mb-2 max-h-[min(18rem,calc(100dvh-9rem))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-2xl border border-black/[0.09] bg-white p-1.5 shadow-[0_14px_36px_-10px_rgba(0,0,0,0.2)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_14px_36px_-10px_rgba(0,0,0,0.65)]"
      style={{ scrollbarWidth: 'thin' }}
    >
      <div className="flex items-center justify-between px-2.5 py-1 text-[11px] text-zinc-400">
        <span>Quick actions {query ? `matching “${query}”` : ''}</span>
        <span>Enter to run · Esc to close</span>
      </div>
      {actions.length === 0 ? (
        <p className="px-2.5 py-3 text-xs text-zinc-500">No matching actions.</p>
      ) : (
        actions.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={item.disabled}
              onMouseDown={(event) => {
                event.preventDefault();
                if (!item.disabled) item.run();
              }}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors disabled:opacity-40 ${
                index === activeIndex
                  ? 'bg-teal-500/12 text-teal-950 dark:bg-teal-500/20 dark:text-teal-100'
                  : 'text-zinc-800 hover:bg-black/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{item.label}</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{item.hint}</span>
              </span>
              {item.shortcut && (
                <kbd className="shrink-0 rounded border border-black/10 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 dark:border-white/10">
                  {item.shortcut}
                </kbd>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
