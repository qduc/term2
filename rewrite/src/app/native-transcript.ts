/** Searchable public transcript identities, reconstructed exclusively from accepted native facts. */
import { initialDirectState, reduceDirectFact } from '../session/direct-state.js';
import type { DirectLogLineage } from '../session/direct-rolling-log.js';
import { DirectProjection } from '../protocol/direct-projection.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';

export type NativeSearchDocument = {
  readonly id: string;
  readonly seq: number;
  readonly kind: string;
  readonly text: string;
};

/** Use the same public reduction as clients, never provider history as searchable text. */
export function nativeTranscript(lineage: DirectLogLineage): readonly NativeSearchDocument[] {
  const workspace = lineage.metadata.workspaceIdentity ?? {
    root: lineage.metadata.workspace,
    target: 'local',
    access: 'read' as const,
  };
  let state = initialDirectState(lineage.logicalSessionId, workspace, lineage.metadata.model);
  const projection = DirectProjection.forReplay(state);
  const sequences = new Map<string, number>();
  const reasoning = new Map<string, NativeSearchDocument>();
  const approvals = new Map<string, NativeSearchDocument>();
  for (const entry of lineage.entries) {
    state = reduceDirectFact(state, entry.fact, entry.seq);
    for (const event of projection.update({ type: 'fact', position: 0, ...entry })) {
      if (event.type === 'message') sequences.set(`message:${event.payload.message.id}`, entry.seq);
      if (event.type === 'reasoning' && event.payload.messageId)
        reasoning.set(event.payload.messageId, {
          id: `reasoning:${event.payload.messageId}`,
          seq: entry.seq,
          kind: 'reasoning',
          text: event.payload.text,
        });
      if (event.type === 'interaction_opened') {
        const request = event.payload.interaction;
        approvals.set(request.requestId, {
          id: `approval:${request.requestId}`,
          seq: entry.seq,
          kind: 'approval',
          text: [request.summary, request.detail ?? ''].join('\n'),
        });
      }
      if (event.type === 'interaction_resolved') {
        const known = approvals.get(event.payload.requestId);
        if (known)
          approvals.set(event.payload.requestId, {
            ...known,
            seq: entry.seq,
            text: `${known.text}\n${JSON.stringify(event.payload.resolution)}`,
          });
      }
      if (event.type === 'tool_started' || event.type === 'tool_called')
        sequences.set(`tool:${event.payload.tool.executionId}`, entry.seq);
      if (event.type === 'tool_finished') sequences.set(`tool:${event.payload.executionId}`, entry.seq);
      if (entry.fact.type === 'session_rotated') {
        reasoning.clear();
        approvals.clear();
      }
    }
  }
  projection.synchronize(state);
  const snapshot = projection.snapshot;
  const docs: NativeSearchDocument[] = [];
  const addSnapshot = (view: Pick<WireSnapshot, 'messages' | 'tools' | 'notices'>, prefix: string, seq: number) => {
    for (const message of view.messages)
      docs.push({
        id: `${prefix}message:${message.id}`,
        seq: sequences.get(`message:${message.id}`) ?? seq,
        kind: message.role,
        text: message.text,
      });
    for (const tool of view.tools)
      docs.push({
        id: `${prefix}tool:${tool.executionId}`,
        seq: sequences.get(`tool:${tool.executionId}`) ?? seq,
        kind: 'tool',
        text: [tool.toolName, JSON.stringify(tool.input), tool.output ?? ''].join('\n'),
      });
    for (const [index, notice] of view.notices.entries())
      docs.push({ id: `${prefix}notice:${index}`, seq, kind: 'notice', text: JSON.stringify(notice) });
  };
  const lastSeq = lineage.entries.at(-1)!.seq;
  addSnapshot(snapshot, '', lastSeq);
  for (const entry of state.timeline)
    if (entry.kind === 'reasoning') {
      const doc = reasoning.get(entry.id);
      if (doc) docs.push(doc);
    }
  docs.push(...approvals.values());
  for (const task of snapshot.tasks)
    docs.push({ id: `task:${task.id}`, seq: lastSeq, kind: 'subagent', text: JSON.stringify(task) });
  for (const branch of snapshot.branches ?? []) {
    const start = docs.length;
    addSnapshot(branch, `branch:${branch.branchId}:`, branch.acceptedSeq);
    for (let index = start; index < docs.length; index++) docs[index] = { ...docs[index]!, kind: 'subagent' };
    if (branch.reasoning)
      docs.push({
        id: `branch:${branch.branchId}:reasoning`,
        seq: branch.acceptedSeq,
        kind: 'subagent',
        text: branch.reasoning,
      });
  }
  return docs.filter((doc) => doc.text.trim().length > 0);
}
