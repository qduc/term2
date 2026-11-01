/** Native transcript command planning, with no log, runtime, execution or physical undo. */
import { createHash } from 'node:crypto';
import type { Item, ItemId } from '../model/index.js';
import { hasCompleteDirectToolPairs } from '../engine/direct-recovery-history.js';
import type {
  DirectCommandOperation,
  DirectCommandSnapshot,
  DirectHistoryCommandPlan,
  DirectRewindTarget,
} from './direct-command-types.js';

type Boundary = {
  readonly index: number;
  readonly through: number;
  readonly item: Extract<Item, { type: 'user_message' }>;
};

/** List only retained original admissions; targets expire on a Session history/configuration revision change. */
export function listDirectRewindTargets(snapshot: DirectCommandSnapshot): readonly DirectRewindTarget[] {
  const boundaries = admissionBoundaries(snapshot);
  return boundaries.map((boundary, position) => {
    const text = boundary.item.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    return {
      id: targetId(snapshot, boundary),
      label: text || '[image input]',
      messageId: boundary.item.id,
      discardedTurns: boundaries.length - position,
      discardedReplies: snapshot.history.slice(boundary.index).filter((item) => item.type === 'assistant_message')
        .length,
      imageCount: boundary.item.content.filter((part) => part.type === 'image').length,
    };
  });
}

/** Propose retry or exclusive rewind from an authoritative settled capture; never mutate physical audit. */
export function planDirectHistoryCommand(
  snapshot: DirectCommandSnapshot,
  operation: Extract<DirectCommandOperation, { kind: 'retry' | 'rewind' }>,
): DirectHistoryCommandPlan {
  if (!snapshot.executionsSettled) return rejected('busy', 'Foreground execution and cleanup must settle first.');
  const boundaries = admissionBoundaries(snapshot);
  let cut: number;
  let next: Extract<DirectHistoryCommandPlan, { kind: 'replace' }>['next'];
  if (operation.kind === 'rewind') {
    const boundary = boundaries.find((candidate) => targetId(snapshot, candidate) === operation.targetId);
    if (!boundary) return rejected('stale', 'Rewind target is no longer present at this revision.');
    cut = boundary.index;
    next = { kind: 'rewound', draft: { content: structuredClone(boundary.item.content) } };
  } else {
    if (operation.target === 'turn') {
      if (operation.executionId !== undefined)
        return rejected('ineligible', 'Turn retry cannot target a tool execution.');
      const boundary = boundaries.at(-1);
      if (!boundary) return rejected('ineligible', 'No retained original user admission can be retried.');
      cut = boundary.through + 1;
    } else {
      let index = -1;
      if (operation.executionId !== undefined) {
        const results = snapshot.toolResults.filter((result) => result.executionId === operation.executionId);
        if (results.length !== 1) return rejected('ineligible', 'No unique root result exists for this execution.');
        index = uniqueIndex(snapshot.history, results[0]!.itemId);
        if (index < 0 || snapshot.history[index]!.type !== 'tool_result')
          return rejected('ineligible', 'The execution result is no longer in retained history.');
      } else {
        for (let position = snapshot.history.length - 1; position >= 0; position--)
          if (snapshot.history[position]!.type === 'tool_result') {
            index = position;
            break;
          }
      }
      if (index < 0) return rejected('ineligible', 'No retained tool output can be retried.');
      cut = index + 1; // Retry from the actual output; do NOT execute the tool again.
    }
    // Original user-side input is already retained. A new engine turn continues
    // with no extra human admission, memory refresh or duplicated user Item.
    next = { kind: 'retry', input: [] };
  }
  const history = structuredClone(snapshot.history.slice(0, cut));
  if (!hasCompleteDirectToolPairs(history))
    return rejected('ineligible', 'The selected boundary would leave an incomplete tool round.');
  return {
    kind: 'replace',
    expectedRevision: snapshot.revision,
    fact: {
      type: 'history_replaced',
      reason: operation.kind === 'rewind' ? 'rewind' : operation.target === 'turn' ? 'retry_turn' : 'retry_tool',
      history,
    },
    clearContinuity: true,
    next,
  };
}

function rejected(code: 'busy' | 'ineligible' | 'stale', message: string): DirectHistoryCommandPlan {
  return { kind: 'rejected', code, message };
}
function uniqueIndex(history: readonly Item[], id: ItemId): number {
  const index = history.findIndex((item) => item.id === id);
  return index < 0 || history.findIndex((item, position) => position > index && item.id === id) >= 0 ? -1 : index;
}
function admissionBoundaries(snapshot: DirectCommandSnapshot): Boundary[] {
  const boundaries: Boundary[] = [];
  const seen = new Set<ItemId>();
  for (const admission of snapshot.admissions) {
    if (seen.has(admission.messageId)) throw new Error('Duplicate native command admission identity');
    seen.add(admission.messageId);
    const index = uniqueIndex(snapshot.history, admission.messageId);
    // Compaction may have removed an older admission. Never reconstruct it from text.
    if (index < 0) continue;
    const item = snapshot.history[index]!;
    if (item.type !== 'user_message') throw new Error('Native command admission is not a user Item');
    const through = uniqueIndex(snapshot.history, admission.retryThroughId);
    if (through < index) throw new Error('Missing native command input/context boundary');
    if (
      snapshot.history
        .slice(index, through + 1)
        .some(
          (candidate) =>
            candidate.type !== 'user_message' && candidate.type !== 'summary' && candidate.type !== 'provider_input',
        )
    )
      throw new Error('Native retry input boundary includes model output or tool work');
    boundaries.push({ index, through, item });
  }
  boundaries.sort((left, right) => left.index - right.index);
  for (let index = 1; index < boundaries.length; index++)
    if (boundaries[index - 1]!.through >= boundaries[index]!.index)
      throw new Error('Overlapping native command admission boundaries');
  return boundaries;
}
function targetId(snapshot: DirectCommandSnapshot, boundary: Boundary): string {
  return `rewind:${createHash('sha256')
    .update(JSON.stringify([snapshot.sessionId, snapshot.revision, boundary.index, boundary.item.id]))
    .digest('hex')}`;
}
