'use client';
import { useId, useState } from 'react';
import { ChevronRight, MessageCircleQuestion, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { InteractionResolveRequest, PendingInteraction, Term2SubagentIdentity } from '../../lib/term2/types';

const VARIANT_CONTEXT: Record<PendingInteraction['variant'], string> = {
  ordinary_tool: 'Tool approval requested',
  folder_read: 'Folder access requested',
  outside_workspace_edit: 'Outside-workspace edit requested',
  denied_read: 'Sandbox denied read',
  docker_host_control: 'Docker host control requested',
  sandbox_network_access: 'Sandbox network access requested',
  post_execute: 'Post-execute approval',
  ask_user: 'Question requested',
  max_turns: 'Turn-limit check-in',
  run_budget: 'Run-budget check-in',
};

export function Term2InteractionPanel({
  interaction,
  recovered,
  subagent,
  onResolve,
  disabled,
}: {
  interaction: PendingInteraction;
  recovered?: boolean;
  /** Set when the pending interaction belongs to a child run. */
  subagent?: Term2SubagentIdentity;
  onResolve: (request: InteractionResolveRequest) => void;
  disabled?: boolean;
}) {
  const [answer, setAnswer] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const submit = async (value: string, approvalAnswer?: string) => {
    const snapshot = { interactionId: interaction.interactionId, revision: interaction.revision };
    setBusy(true);
    try {
      await onResolve({
        ...snapshot,
        answer: value,
        ...(approvalAnswer === undefined ? {} : { approvalAnswer }),
        ...(interaction.kind === 'tool_approval' && rejectionReason ? { rejectionReason } : {}),
      });
    } finally {
      setBusy(false);
    }
  };
  if (recovered)
    return (
      <section
        role="alert"
        className="t2-enter flex gap-3 rounded-2xl border border-amber-500/25 bg-amber-50/70 p-4 text-sm text-amber-950 dark:bg-amber-950/20 dark:text-amber-100"
      >
        <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <h2 className="font-medium">Interaction recovered after restart</h2>
          <p className="mt-0.5 text-amber-900/80 dark:text-amber-100/70">
            This interaction cannot be answered. Reload the session to continue safely.
          </p>
        </div>
      </section>
    );
  const askUser = interaction.askUser;
  const question = askUser?.questions[askUser.currentQuestionIndex];
  const multiSelect = question?.multiSelect === true;
  const toggleOption = (optionIndex: number) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(optionIndex)) next.add(optionIndex);
      return next;
    });
  // A multi-select answer is a JSON array of the chosen labels, in option order. The gateway validates
  // it on the `custom` choice. The TUI sends the same shape (a JSON array of labels) but orders it by
  // click order and allows an empty submit; the web orders by option and requires at least one.
  const submitSelection = () => {
    if (!question || selected.size === 0) return;
    const labels = question.options.filter((_, optionIndex) => selected.has(optionIndex)).map((option) => option.label);
    void submit('custom', JSON.stringify(labels));
  };
  const display = interaction.descriptor.display;
  const primaryChoiceId = interaction.choices.find((choice) => !choice.destructive)?.id;
  const HeaderIcon = askUser ? MessageCircleQuestion : ShieldAlert;
  const field = 'min-w-0 flex-1 basis-full rounded-lg sm:basis-0 border border-black/[0.08] bg-white px-3 py-1.5 text-sm outline-none transition-colors placeholder:text-zinc-400 focus:border-teal-500/60 focus:ring-2 focus:ring-teal-500/15 dark:border-white/10 dark:bg-zinc-950/60';
  const secondaryButton = 'rounded-lg border border-black/[0.1] bg-white px-3.5 py-1.5 text-sm font-medium text-zinc-800 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-white/10 dark:bg-transparent dark:text-zinc-200 dark:hover:bg-white/[0.06]';
  const primaryButton = 'rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white';
  const destructiveButton = 'rounded-lg border border-black/[0.1] bg-white px-3.5 py-1.5 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:opacity-50 dark:border-white/10 dark:bg-transparent dark:text-red-400 dark:hover:border-red-900 dark:hover:bg-red-950/40';
  return (
    <section
      aria-labelledby="term2-interaction-heading"
      className="t2-enter overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)] ring-1 ring-amber-500/20 dark:border-white/[0.08] dark:bg-zinc-900 dark:shadow-none"
    >
      <div className="flex gap-3 px-4 pt-4">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <HeaderIcon aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Action required{subagent ? ` · Subagent: ${subagent.role}` : ''}
          </p>
          <h2 id="term2-interaction-heading" className="mt-0.5 font-medium text-zinc-900 dark:text-zinc-100">
            {VARIANT_CONTEXT[interaction.variant]}
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            {display?.warning || (
              <>
                <span className="font-mono text-[13px]">{interaction.descriptor.toolName}</span>
                {interaction.descriptor.agentName ? ` · requested by ${interaction.descriptor.agentName}` : ''}
              </>
            )}
          </p>
        </div>
      </div>
      <div aria-label="Interaction details" className="space-y-2 px-4 pt-3 text-sm">
        {display?.command && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-950 px-3.5 py-2.5 font-mono text-[12.5px] leading-5 text-zinc-100 dark:bg-black/50">
            <span className="select-none text-teal-400">$ </span>
            {display.command}
          </pre>
        )}
        {(display?.target || display?.scope || interaction.descriptor.deniedRead) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
            {display?.target && (
              <>
                <dt className="text-zinc-500">Target</dt>
                <dd className="min-w-0 break-words font-mono text-[12.5px]">{display.target}</dd>
              </>
            )}
            {display?.scope && (
              <>
                <dt className="text-zinc-500">Scope</dt>
                <dd className="min-w-0 break-words">{display.scope}</dd>
              </>
            )}
            {interaction.descriptor.deniedRead && (
              <>
                <dt className="text-zinc-500">Denied path</dt>
                <dd className="min-w-0 break-words font-mono text-[12.5px]">
                  {interaction.descriptor.deniedRead.displayPath}
                </dd>
                <dt className="text-zinc-500">Denied parent</dt>
                <dd className="min-w-0 break-words font-mono text-[12.5px]">
                  {interaction.descriptor.deniedRead.displayParent}
                </dd>
                <dt className="text-zinc-500">Sensitive read</dt>
                <dd>{interaction.descriptor.deniedRead.sensitive ? 'Yes' : 'No'}</dd>
              </>
            )}
          </dl>
        )}
        {interaction.descriptor.argumentsText &&
          (display?.command ? (
            <details className="group/args">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open/args:rotate-90" />
                Raw arguments
              </summary>
              <pre
                aria-label="Interaction arguments"
                className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2.5 font-mono text-[12px] leading-5 dark:bg-white/[0.04]"
              >
                {interaction.descriptor.argumentsText}
              </pre>
            </details>
          ) : (
            <pre
              aria-label="Interaction arguments"
              className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2.5 font-mono text-[12px] leading-5 dark:bg-white/[0.04]"
            >
              {interaction.descriptor.argumentsText}
            </pre>
          ))}
      </div>
      {askUser && (
        <div className="px-4 pt-3">
          <p id={questionId} className="font-medium text-zinc-900 dark:text-zinc-100">
            {question?.question}
          </p>
          <div
            className="mt-2.5 flex flex-wrap gap-2"
            role={multiSelect ? 'group' : undefined}
            aria-labelledby={multiSelect ? questionId : undefined}
          >
            {multiSelect
              ? question?.options.map((option, optionIndex) => (
                  <label
                    key={optionIndex}
                    title={option.description}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-black/[0.1] px-3 py-1.5 text-sm transition-colors hover:bg-zinc-50 has-[:checked]:border-teal-500/50 has-[:checked]:bg-teal-500/10 dark:border-white/10 dark:hover:bg-white/[0.05]"
                  >
                    <input
                      type="checkbox"
                      className="accent-teal-600"
                      checked={selected.has(optionIndex)}
                      disabled={disabled || busy}
                      onChange={() => toggleOption(optionIndex)}
                    />
                    {option.label}
                  </label>
                ))
              : question?.options.map((option, optionIndex) => (
                  <button
                    type="button"
                    key={optionIndex}
                    title={option.description}
                    className={secondaryButton}
                    disabled={disabled || busy}
                    onClick={() => void submit(`option:${optionIndex}`)}
                  >
                    {option.label}
                  </button>
                ))}
          </div>
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-black/[0.06] bg-zinc-50/70 px-4 py-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
        {interaction.kind === 'tool_approval' && (
          <input
            aria-label="Optional rejection reason"
            className={field}
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value.slice(0, 2048))}
            placeholder="Reason for rejecting (optional)"
            disabled={disabled || busy}
          />
        )}
        {askUser && (
          <>
            <input
              aria-label="Custom answer"
              className={field}
              value={answer}
              onChange={(event) => setAnswer(event.target.value.slice(0, 16384))}
              placeholder="Or type your own answer"
              disabled={disabled || busy}
            />
            <button
              type="button"
              className={primaryButton}
              disabled={disabled || busy || !answer.trim()}
              onClick={() => void submit('custom', answer)}
            >
              Send
            </button>
            {multiSelect && (
              <button
                type="button"
                className={primaryButton}
                disabled={disabled || busy || selected.size === 0}
                onClick={submitSelection}
              >
                Submit answer
              </button>
            )}
            {interaction.choices
              .filter((choice) => choice.id === 'decline' || choice.id === 'cancel')
              .map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  className={destructiveButton}
                  disabled={disabled || busy}
                  onClick={() => void submit(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
          </>
        )}
        {!askUser && (
          <div className="ml-auto flex flex-wrap gap-2">
            {interaction.choices.map((choice) => (
              <button
                type="button"
                key={choice.id}
                title={choice.description}
                className={
                  choice.destructive ? destructiveButton : choice.id === primaryChoiceId ? primaryButton : secondaryButton
                }
                disabled={disabled || busy}
                onClick={() => void submit(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
