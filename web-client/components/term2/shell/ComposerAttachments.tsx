'use client';

import { Wand2, X } from 'lucide-react';
import { useShell, useShellState } from './ShellContext';

/** The armed skill and the attached images, above the message box. */
export function ComposerAttachments() {
  const { dispatch } = useShell();
  const armedSkill = useShellState((s) => s.composer.armedSkill);
  const attachments = useShellState((s) => s.composer.attachments);
  if (!(armedSkill || attachments.length > 0)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
      {armedSkill && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/12 px-2.5 py-1 text-xs font-medium text-teal-800 dark:bg-teal-500/20 dark:text-teal-200">
          <Wand2 className="h-3 w-3" />
          Skill: {armedSkill}
          <button
            type="button"
            aria-label="Remove skill"
            onClick={() => dispatch({ type: 'COMPOSER_EDITED', patch: { armedSkill: null } })}
            className="rounded-full p-0.5 hover:bg-teal-500/20"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      {attachments.map((img) => (
        <div
          key={img.id}
          className="relative flex items-center gap-1.5 rounded-xl border border-black/[0.08] bg-zinc-50 p-1 pr-2 dark:border-white/10 dark:bg-zinc-900"
        >
          <img src={img.previewUrl} alt={img.name} className="h-9 w-9 rounded-lg object-cover" />
          <span className="max-w-[7rem] truncate text-xs text-zinc-600 dark:text-zinc-300">
            {img.name}
          </span>
          <button
            type="button"
            aria-label={`Remove ${img.name}`}
            onClick={() =>
              dispatch({ type: 'COMPOSER_EDITED', patch: { attachments: attachments.filter((a) => a.id !== img.id) } })
            }
            className="rounded-full p-0.5 text-zinc-400 hover:bg-black/[0.06] hover:text-zinc-800 dark:hover:bg-white/10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
