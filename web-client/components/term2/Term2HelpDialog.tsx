'use client';

import { Folder, ImagePlus, Keyboard, ShieldCheck, Sparkles } from 'lucide-react';

export function Term2HelpDialog({ allowWrite }: { allowWrite: boolean }) {
  return (
    <div className="space-y-5 text-sm text-zinc-700 dark:text-zinc-300">
      <section>
        <h3 className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          Getting started
        </h3>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] leading-5">
          <li>
            <strong>Connect an AI provider</strong> in <em>Settings → Providers &amp; Keys</em> (API key, OAuth sign-in,
            or a local server like Ollama / LM Studio).
          </li>
          <li>
            <strong>Choose a folder</strong> from the sidebar or landing page. Term2 only accesses files inside the
            folder you approve.
          </li>
          <li>
            <strong>Start chatting</strong> — switch models or reasoning effort anytime right from the message bar, or
            click <em>New chat</em> to start a fresh conversation in the same folder.
          </li>
        </ol>
      </section>

      <section>
        <h3 className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <ImagePlus className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          Files, images &amp; skills
        </h3>
        <ul className="mt-2 space-y-1.5 text-[13px] leading-5">
          <li>
            Type <kbd className="rounded border border-black/15 px-1.5 py-0.5 font-mono text-[11px] dark:border-white/15">@</kbd>{' '}
            in the message box to search and insert a file path from your folder.
          </li>
          <li>
            Paste screenshots from your clipboard, drag-and-drop images onto the composer, or click the image icon to
            attach up to 4 images.
          </li>
          <li>
            Use the <strong>Skills</strong> button to attach reusable workflow instructions to your next message.
          </li>
          <li>
            Hover any previous message to <strong>Copy</strong> or <strong>Rewind &amp; edit</strong> the conversation
            from that point.
          </li>
        </ul>
      </section>

      <section>
        <h3 className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <ShieldCheck className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          Approvals &amp; folder permissions
        </h3>
        <p className="mt-1.5 text-[13px] leading-5 text-zinc-600 dark:text-zinc-400">
          For your safety, tool actions ask for your approval before running.{' '}
          {allowWrite ? (
            <>Write access is enabled for folders granted read-and-write access.</>
          ) : (
            <>
              This web session is currently <strong>read-only</strong>. To allow file editing, launch with{' '}
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[12px] dark:bg-zinc-800">
                term2-web --allow-write
              </code>
              .
            </>
          )}
        </p>
      </section>

      <section>
        <h3 className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <Keyboard className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          Keyboard shortcuts
        </h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <dt className="font-mono text-xs text-zinc-500">Enter</dt>
          <dd>Send message (or steer the active turn while streaming)</dd>
          <dt className="font-mono text-xs text-zinc-500">Shift + Enter</dt>
          <dd>Insert a new line</dd>
          <dt className="font-mono text-xs text-zinc-500">Alt + Enter</dt>
          <dd>Queue a follow-up message to run after the current turn</dd>
          <dt className="font-mono text-xs text-zinc-500">⌘K / Ctrl+K</dt>
          <dd>Open quick actions menu (or type / at the start of an empty message)</dd>
          <dt className="font-mono text-xs text-zinc-500">↑ / ↓</dt>
          <dd>Browse your recent sent prompts on an empty composer</dd>
          <dt className="font-mono text-xs text-zinc-500">Esc</dt>
          <dd>Close open menus or dialogs</dd>
        </dl>
      </section>

      <div className="flex items-center gap-2 rounded-xl bg-zinc-100/80 px-3.5 py-2.5 text-xs text-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-400">
        <Folder className="h-4 w-4 shrink-0 text-zinc-400" />
        <span>Everything stays local on your machine — conversations are saved in your Term2 state directory.</span>
      </div>
    </div>
  );
}
