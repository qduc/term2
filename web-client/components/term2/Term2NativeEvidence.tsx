'use client';

import type { AgentChangeV2, Term2SessionView } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2SubagentCard } from './Term2SubagentCard';
import { Term2ToolGroup } from './Term2ToolGroup';

function NativeChange({ change }: { change: AgentChangeV2 }) {
  const payload: Readonly<Record<string, unknown>> = change.payload;
  return <article className="my-2 rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
    <h3 className="font-semibold">{change.type.replaceAll('_', ' ')}</h3>
    {change.type === 'reasoning' && typeof payload.text === 'string' && <Term2Markdown text={payload.text} />}
    {change.type === 'reasoning_delta' && typeof payload.delta === 'string' && <Term2Markdown text={payload.delta} />}
    {(change.type === 'tool_progress' || change.type === 'task_progress') && typeof payload.chunk === 'string' && <pre className="whitespace-pre-wrap">{payload.chunk}</pre>}
    {change.type === 'queue_changed' && Array.isArray(payload.entries) && <ul aria-label="Current native queue">
      {payload.entries.map((value, index) => {
        if (!value || typeof value !== 'object') return null;
        const entry = value as Record<string, unknown>;
        return <li key={typeof entry.messageId === 'string' ? entry.messageId : index}>{typeof entry.delivery === 'string' ? entry.delivery : ''}: {typeof entry.text === 'string' ? entry.text : ''}</li>;
      })}
    </ul>}
    {change.type.startsWith('context_compaction_') && <p>Native attempt evidence. Estimates are context estimates, not charged usage; request references are not additional charges.</p>}
    {change.type === 'tool_call_streaming_delta' && typeof payload.argumentCharCount === 'number' && <p>Streaming tool arguments: {payload.argumentCharCount} characters{typeof payload.toolName === 'string' ? ` · ${payload.toolName}` : ''}</p>}
    {change.type === 'automatic_memory_notice' && typeof payload.output === 'string' && <pre className="whitespace-pre-wrap">{payload.output}</pre>}
    {change.type === 'session_rotated' && <p>Root provider context rotated; branch/task/queue and cost evidence retained.</p>}
    <details><summary>Exact native fields</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(change, null, 2)}</pre></details>
  </article>;
}

/** This is the exact root evidence at a named accepted hydration cut, not a
 * manufactured current aggregate or a replay event. */
function HydrationEvidence({ view }: { view: Term2SessionView }) {
  const hydration = view.hydration;
  if (!hydration) return null;
  const snapshot = hydration.snapshot;
  const arrays = (key: string): Record<string, unknown>[] => Array.isArray(snapshot[key]) ? (snapshot[key] as unknown[]).filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
  const unbound = snapshot.messages.filter(message => typeof message.turnId !== 'string' || message.role === 'tool');
  const usage = snapshot.usage as Record<string, unknown>;
  const cost = snapshot.cost && typeof snapshot.cost === 'object' ? snapshot.cost as Record<string, unknown> : null;
  return <section aria-label="Native accepted hydration cut" className="my-3 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
    <h3 className="font-semibold">Root accepted cut {hydration.seq} · backing {snapshot.backingSessionId}</h3>
    <p>This is the source-backed hydration cut; later accepted/live changes are shown separately below. Task metadata is not a branch transcript.</p>
    <p>{snapshot.branches === undefined ? 'Branch hydration capability unavailable; no child history was fabricated.' : snapshot.branches.length === 0 ? 'No accepted branches at this cut.' : 'Native branch observations at this same root cut are rendered separately below; their acceptedSeq is not a reconnect cursor.'}</p>
    <p>Usage at cut: input {String(usage.inputTokens)} · output {String(usage.outputTokens)} · cached input {String(usage.cachedInputTokens)}</p>
    <p>Aggregate cost at cut: {cost && typeof cost.totalUsd === 'number' && cost.currency === 'USD' ? `${cost.totalUsd} USD (as supplied)` : 'unavailable'}. Request-cost records are retained, not re-summed or billed again. Historical notices/aggregate costs may be incomplete on fresh process hydration.</p>
    {arrays('queue').length > 0 && <div><h4>Queue at cut</h4><ul>{arrays('queue').map((entry, index) => <li key={typeof entry.messageId === 'string' ? entry.messageId : index}>{typeof entry.delivery === 'string' ? entry.delivery : ''}: {typeof entry.text === 'string' ? entry.text : ''}</li>)}</ul></div>}
    {arrays('tasks').length > 0 && <div><h4>Native task metadata at cut</h4>{arrays('tasks').map((task, index) => <details key={typeof task.id === 'string' ? task.id : index}><summary>{typeof task.id === 'string' ? task.id : ''} · {typeof task.status === 'string' ? task.status : ''}{typeof task.label === 'string' ? ` · ${task.label}` : ''}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(task, null, 2)}</pre></details>)}</div>}
    {typeof snapshot.reasoning === 'string' && snapshot.reasoning && <details><summary>Root reasoning at cut (native owner in exact fields)</summary><Term2Markdown text={snapshot.reasoning} /></details>}
    {unbound.map(message => <article key={String(message.id)}><p>Native {String(message.role)} message {String(message.id)} (no guessed turn ownership)</p><Term2Markdown text={String(message.text)} /></article>)}
    {snapshot.timeline === null && snapshot.tools.length > 0 && <div role="alert"><p>Mixed transcript order is unavailable. Messages/tools are shown separately, not in invented chronological order.</p>{snapshot.messages.filter(message => !unbound.includes(message)).map(message => <Term2Markdown key={String(message.id)} text={String(message.text)} />)}<pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(snapshot.tools, null, 2)}</pre></div>}
    <details><summary>Exact root snapshot: configuration, queue/tasks, goals/verification, request costs, notices, interactions and commands</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(hydration, null, 2)}</pre></details>
  </section>;
}

function BranchEvidence({ view }: { view: Term2SessionView }) {
  const branch = view.nativeBranch;
  if (!branch) return null;
  return <section aria-label="Accepted branch hydration" className="text-xs">
    <p>Accepted branch observation through {branch.acceptedSeq}, read at the enclosing root cut. This is not proof the child is physically running.</p>
    <p>Branch queue unavailable (native queue: null). Branch request-cost records select the same root charges; they are not an additional aggregate.</p>
    {branch.usage === null && <p>Branch usage unobserved.</p>}
    {branch.reasoning === null && <p>No accepted branch reasoning summary observed. Raw reasoning chunks and intermediate tool progress are live-only; interrupted prefixes are not recovered after reconnect/crash.</p>}
    {branch.messages.filter(message => typeof message.turnId !== 'string' || message.role === 'tool').map(message => <article key={String(message.id)}><p>Native message {String(message.id)} (no guessed ownership)</p><Term2Markdown text={String(message.text)} /></article>)}
    {branch.timeline === null && branch.tools.length > 0 && <p role="alert">Mixed branch transcript ordering is unavailable; exact messages/tools remain in the native fields below.</p>}
    <details><summary>Exact accepted branch fields, nullable evidence and request costs</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(branch, null, 2)}</pre></details>
  </section>;
}

/** State below is observed public evidence, not an independently computed bill
 * or a claim that a native verification proves the user's task complete. */
function PublicStateEvidence({ view, isBranch }: { view: Term2SessionView; isBranch: boolean }) {
  const state = view.nativeState;
  if (!state) return null;
  return <section aria-label="Observed native public state" className="my-3 rounded border border-zinc-200 p-3 text-xs dark:border-zinc-800">
    <h3 className="font-semibold">Observed native public state</h3>
    <p>Hydrated evidence plus later accepted changes. Missing historical evidence is not reconstructed. Explicit nulls, empty arrays and recorded zeros remain distinct from unavailable fields.</p>
    {'cost' in state && <p>Aggregate cost: {state.cost === null ? 'unavailable (native null)' : state.cost === undefined ? 'unavailable' : `${state.cost.totalUsd} ${state.cost.currency} (native replacement state)`}. Not added to request receipts.</p>}
    {state.requestCosts !== undefined && <div>
      <h4>Physical request receipts{isBranch ? ' · branch-selected view of root records' : ''}</h4>
      <p>No receipt is summed into an aggregate here. Corrections replace the same request ID; signed accounting and omitted metrics are preserved. Branch copies and compaction references are not extra charges.</p>
      {state.requestCosts.length === 0 && <p>No request receipts in the supplied state.</p>}
      {state.requestCosts.map(receipt => <details key={receipt.record.requestId}>
        <summary>{receipt.record.requestId} · {String(receipt.record.outcome)} · turn {receipt.turnId} · root {receipt.rootTurnId}{receipt.parentTurnId !== undefined ? ` · parent ${receipt.parentTurnId}` : ''}</summary>
        <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(receipt, null, 2)}</pre>
      </details>)}
    </div>}
    {'goal' in state && <div><h4>Active/native goal state</h4>{state.goal === null ? <p>Cleared (native null).</p> : <pre className="whitespace-pre-wrap">{JSON.stringify(state.goal, null, 2)}</pre>}</div>}
    {state.goalGeneration !== undefined && <p>Native goal generation: {state.goalGeneration}</p>}
    {'goalProposal' in state && <div><h4>Goal proposal (not an active goal)</h4><pre className="whitespace-pre-wrap">{JSON.stringify(state.goalProposal, null, 2)}</pre></div>}
    {'verification' in state && <div><h4>Native verification state (not browser acceptance)</h4><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(state.verification, null, 2)}</pre></div>}
    {state.notices !== undefined && <div><h4>Observed notices</h4>{state.notices.length === 0 && <p>No notices in supplied state; fresh-process historical coverage may be incomplete.</p>}{state.notices.map((notice, index) => <p key={index}>{String(notice.kind)}: {String(notice.message)}</p>)}</div>}
    {state.notifications !== undefined && <div><h4>Background notices and actual silent-turn deliveries</h4><p>Delivery identities do not create a foreground conversation turn. Enqueued notices remain evidence even after delivery.</p><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(state.notifications, null, 2)}</pre></div>}
  </section>;
}

/** Native evidence is not squeezed into v1 turn/tool identities or usage counters.
 * Positional React keys below are rendering positions only, never wire IDs/cursors. */
export function Term2NativeEvidence({ view, isBranch = false }: { view: Term2SessionView; isBranch?: boolean }) {
  const branches = Object.values(view.branches ?? {});
  const retainedTasks = view.retiredTurns?.flatMap(turn => turn.subagents ?? []) ?? [];
  if (!view.hydration && !view.nativeBranch && !view.rootEvidence && !view.nativeState && !view.nativeChanges?.length && !view.liveChanges?.length && !branches.length && !retainedTasks.length && view.replayMode !== 'unavailable') return null;
  return <section aria-label="Native session evidence" className="mt-4">
    <HydrationEvidence view={view} />
    {!view.hydration && view.rootEvidence && <details><summary>Preserved noncontext root evidence (queue/tasks/usage/costs/goals/notices)</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(view.rootEvidence, null, 2)}</pre></details>}
    <BranchEvidence view={view} />
    <PublicStateEvidence view={view} isBranch={isBranch} />
    {view.replayMode === 'unavailable' && <p role="status" className="text-xs">Live stream: replay is unavailable. Activity missed while disconnected cannot be reconstructed by this browser.</p>}
    {retainedTasks.map((card, index) => <Term2SubagentCard key={index} card={card} />)}
    <p className="my-2 text-xs">Raw reasoning chunks and intermediate tool-progress updates are visible live but may be unavailable after reconnect or crash. Recovery uses actually accepted reasoning summaries and final tool results, not the original raw stream or an interrupted prefix. This is an explicit raw-stream replay parity exception, not full replay parity.</p>
    {view.nativeChanges?.map((change, index) => <NativeChange key={index} change={change} />)}
    {!!view.liveChanges?.length && <section aria-label="Live-only connection observations"><h3 className="text-xs font-semibold">Live-only reasoning/progress and other transient observations · this connection only</h3>{view.liveChanges.map((change, index) => <NativeChange key={index} change={change} />)}</section>}
    {branches.map(({ identity, view: branch }) => <section key={identity.branchId} aria-label={`Branch ${identity.branchId}`} className="my-3 border-l-2 border-zinc-300 pl-3 dark:border-zinc-700">
      <h3 className="text-sm font-semibold">Task {identity.taskId} · branch {identity.branchId}</h3>
      <p className="text-xs">Turn {identity.turnId}{identity.parentTurnId !== undefined ? ` · parent ${identity.parentTurnId}` : ''}{identity.rootTurnId !== undefined ? ` · root ${identity.rootTurnId}` : ''}</p>
      {branch.reloadRequired && <p role="alert">Branch history was replaced. A branch-complete accepted projection is required to reload this context.</p>}
      {!branch.reloadRequired && branch.turns.map(turn => <article key={turn.turnId} className="my-2 text-sm">
        <p>{turn.status}</p>
        {turn.reasoning && <details><summary>Reasoning</summary><Term2Markdown text={turn.reasoning} /></details>}
        {turn.text && <Term2Markdown text={turn.text} />}
        <Term2ToolGroup commands={turn.commands} />
      </article>)}
      <Term2NativeEvidence view={branch} isBranch />
    </section>)}
  </section>;
}
