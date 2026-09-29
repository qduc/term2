'use client';
import type { Term2Command } from '../../lib/term2/types';

export function Term2CommandCard({ command }: { command: Term2Command }) {
  return (
    <article
      className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-700 dark:bg-zinc-800"
      aria-label={`Tool ${command.toolName} ${command.status}`}
    >
      <div className="flex items-center justify-between">
        <strong>{command.toolName}</strong>
        <span className="text-xs text-zinc-500">{command.status}</span>
      </div>
      {command.argumentsText && (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">
          {command.argumentsText}
        </pre>
      )}
      {command.output && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{command.output}</pre>
      )}
      {command.error && <p className="mt-2 text-xs text-red-700">{command.error}</p>}
    </article>
  );
}
