'use client';

import { useEffect, useRef } from 'react';
import { FileText, Folder, Sparkles, Wand2, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
      className="t2-enter absolute bottom-full left-0 z-40 mb-2 max-h-64 w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 scrollbar-thin"
    >
      <div className="flex items-center justify-between px-2.5 py-1 text-xs text-muted-foreground">
        <span>Mention a file {query ? `matching “${query}”` : ''}</span>
        <span>Enter or Tab to insert</span>
      </div>
      {loading && entries.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-muted-foreground">Scanning folder files…</p>
      )}
      {!loading && entries.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-muted-foreground">No matching files in this folder.</p>
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
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
            index === activeIndex
              ? 'bg-accent text-accent-foreground'
              : 'hover:bg-accent'
          }`}
        >
          {entry.type === 'directory' ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono text-xs">
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
    <>
      <div className="flex items-center justify-between px-2.5 py-1.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-foreground">
          <Wand2 className="h-3 w-3 text-muted-foreground" />
          Skills
        </span>
        {selectedSkill && (
          <Button type="button" variant="link" size="xs" className="h-auto p-0" onClick={() => onSelect(null)}>
            Clear active
          </Button>
        )}
      </div>
      {loading && skills.length === 0 && <p className="px-2.5 py-3 text-xs text-muted-foreground">Loading skills…</p>}
      {!loading && skills.length === 0 && (
        <p className="px-2.5 py-3 text-xs text-muted-foreground">
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
            className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
              active
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent'
            }`}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{skill.name}</span>
              {skill.isProjectLevel && (
                <Badge variant="secondary" className="ml-auto">
                  Project
                </Badge>
              )}
            </span>
            {skill.description && (
              <span className="line-clamp-2 text-xs text-muted-foreground dark:text-muted-foreground">{skill.description}</span>
            )}
          </button>
        );
      })}
    </>
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
      className="t2-enter absolute bottom-full left-0 z-50 mb-2 max-h-[min(18rem,calc(100dvh-9rem))] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 scrollbar-thin"
      style={{ scrollbarWidth: 'thin' }}
    >
      <div className="flex items-center justify-between px-2.5 py-1 text-xs text-muted-foreground">
        <span>Quick actions {query ? `matching “${query}”` : ''}</span>
        <span>Enter to run · Esc to close</span>
      </div>
      {actions.length === 0 ? (
        <p className="px-2.5 py-3 text-xs text-muted-foreground">No matching actions.</p>
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
              className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors disabled:opacity-40 ${
                index === activeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent'
              }`}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground dark:text-muted-foreground">{item.hint}</span>
              </span>
              {item.shortcut && (
                <kbd className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
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
