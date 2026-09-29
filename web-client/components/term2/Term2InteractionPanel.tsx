'use client';
import { useState } from 'react';
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
      <section role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <h2 className="font-semibold">Interaction recovered after restart</h2>
        <p>This interaction cannot be answered. Reload the session to continue safely.</p>
      </section>
    );
  const askUser = interaction.askUser;
  return (
    <section
      aria-labelledby="term2-interaction-heading"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950"
    >
      <h2 id="term2-interaction-heading" className="font-semibold">
        Action required: {interaction.variant.replaceAll('_', ' ')}
      </h2>
      {subagent && <p className="mt-1 text-sm font-medium">Subagent: {subagent.role}</p>}
      <p className="mt-1 text-sm">{interaction.descriptor.display?.warning || interaction.descriptor.toolName}</p>
      <div aria-label="Interaction details" className="mt-3 rounded border border-amber-200 bg-white/60 p-3 text-sm">
        <p className="font-medium">{VARIANT_CONTEXT[interaction.variant]}</p>
        {interaction.descriptor.argumentsText && (
          <pre aria-label="Interaction arguments" className="mt-2 whitespace-pre-wrap text-xs">
            {interaction.descriptor.argumentsText}
          </pre>
        )}
        {interaction.descriptor.display?.command && (
          <p className="mt-2">
            <span className="font-medium">Command:</span> {interaction.descriptor.display.command}
          </p>
        )}
        {interaction.descriptor.display?.target && (
          <p className="mt-2">
            <span className="font-medium">Target:</span> {interaction.descriptor.display.target}
          </p>
        )}
        {interaction.descriptor.display?.scope && (
          <p className="mt-2">
            <span className="font-medium">Scope:</span> {interaction.descriptor.display.scope}
          </p>
        )}
        {interaction.descriptor.deniedRead && (
          <div className="mt-2 space-y-1">
            <p>
              <span className="font-medium">Denied path:</span> {interaction.descriptor.deniedRead.displayPath}
            </p>
            <p>
              <span className="font-medium">Denied parent:</span> {interaction.descriptor.deniedRead.displayParent}
            </p>
            <p>
              <span className="font-medium">Sensitive read:</span>{' '}
              {interaction.descriptor.deniedRead.sensitive ? 'Yes' : 'No'}
            </p>
          </div>
        )}
      </div>
      {askUser && (
        <div className="mt-3">
          <p className="font-medium">{askUser.questions[askUser.currentQuestionIndex]?.question}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {askUser.questions[askUser.currentQuestionIndex]?.options.map((option, optionIndex) => (
              <button
                type="button"
                key={option.label}
                className="rounded border border-amber-700 px-3 py-1 text-sm"
                disabled={disabled || busy}
                onClick={() => void submit(`option:${optionIndex}`)}
              >
                {option.label}
              </button>
            ))}
            {interaction.choices
              .filter((choice) => choice.id === 'decline' || choice.id === 'cancel')
              .map((choice) => (
                <button
                  type="button"
                  key={choice.id}
                  className="rounded border border-red-700 px-3 py-1 text-sm text-red-700"
                  disabled={disabled || busy}
                  onClick={() => void submit(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
          </div>
        </div>
      )}
      {!askUser && (
        <div className="mt-3 flex flex-wrap gap-2">
          {interaction.choices.map((choice) => (
            <button
              type="button"
              key={choice.id}
              className={`rounded border px-3 py-1 text-sm ${
                choice.destructive ? 'border-red-700 text-red-700' : 'border-amber-700'
              }`}
              disabled={disabled || busy}
              onClick={() => void submit(choice.id)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}
      {interaction.kind === 'tool_approval' && (
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Optional rejection reason"
            className="min-w-0 flex-1 rounded border border-amber-400 bg-white px-2 py-1 text-sm"
            value={rejectionReason}
            onChange={(event) => setRejectionReason(event.target.value.slice(0, 2048))}
            placeholder="Optional reason"
            disabled={disabled || busy}
          />
        </div>
      )}
      {askUser && (
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Custom answer"
            className="min-w-0 flex-1 rounded border border-amber-400 bg-white px-2 py-1 text-sm"
            value={answer}
            onChange={(event) => setAnswer(event.target.value.slice(0, 16384))}
            placeholder="Custom answer"
            disabled={disabled || busy}
          />
          <button
            type="button"
            className="rounded bg-amber-800 px-3 py-1 text-sm text-white"
            disabled={disabled || busy || !answer.trim()}
            onClick={() => void submit('custom', answer)}
          >
            Send
          </button>
        </div>
      )}
    </section>
  );
}
