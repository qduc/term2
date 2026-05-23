export interface ConversationHistoryRepairStats {
  count: number;
  duplicatePairs: number;
  maxCopies: number;
}

export interface ConversationHistoryRepair {
  kind: 'replayed_full_history_prefix' | 'duplicated_tool_call_result_pair';
  removedItems: number;
  beforeCount: number;
  afterCount: number;
  duplicatePairsBefore: number;
  maxCopiesBefore: number;
}

export interface ConversationHistoryRepairSummary {
  repaired: boolean;
  removedItems: number;
  repairs: ConversationHistoryRepair[];
  statsBefore: ConversationHistoryRepairStats;
  statsAfter: ConversationHistoryRepairStats;
}

export interface ConversationHistoryRepairResult extends ConversationHistoryRepairSummary {
  history: unknown[];
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const rawItem = (item: unknown): Record<string, unknown> | null => {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  return asRecord(record.rawItem) ?? record;
};

const callIdOf = (raw: Record<string, unknown> | null): string | null => {
  const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id;
  return typeof callId === 'string' && callId ? callId : null;
};

const typeOf = (raw: Record<string, unknown> | null): string => {
  const type = raw?.type;
  return typeof type === 'string' ? type : '';
};

const cloneHistory = (history: unknown[]): unknown[] => {
  try {
    return structuredClone(history);
  } catch {
    return history.slice();
  }
};

const itemSignature = (item: unknown): string => {
  const raw = rawItem(item);
  const callId = callIdOf(raw);
  const type = typeOf(raw);
  if (callId) {
    return `call:${callId}:${type}`;
  }

  const id = raw?.id;
  if (typeof id === 'string' && id) {
    return `id:${id}`;
  }

  const role = raw?.role;
  let text = '';
  const content = raw?.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((part: any) => typeof part?.text === 'string')
      .map((part: any) => part.text)
      .join('');
  }

  if (typeof role === 'string' && role) {
    return `msg:${role}:${type}:${text}`;
  }

  const name = raw?.name;
  return `item:${type}:${typeof name === 'string' ? name : ''}`;
};

const collectCallSignatures = (items: unknown[]): Set<string> => {
  const signatures = new Set<string>();
  for (const item of items) {
    const signature = itemSignature(item);
    if (signature.startsWith('call:')) {
      signatures.add(signature);
    }
  }
  return signatures;
};

const countDuplicatePairs = (
  items: unknown[],
): Pick<ConversationHistoryRepairStats, 'duplicatePairs' | 'maxCopies'> => {
  const calls = new Map<string, number>();
  const results = new Map<string, number>();

  for (const item of items) {
    const raw = rawItem(item);
    const callId = callIdOf(raw);
    if (!callId) {
      continue;
    }

    const type = typeOf(raw);
    if (type === 'function_call') {
      calls.set(callId, (calls.get(callId) ?? 0) + 1);
    } else if (type === 'function_call_result') {
      results.set(callId, (results.get(callId) ?? 0) + 1);
    }
  }

  let duplicatePairs = 0;
  let maxCopies = 0;
  for (const [callId, callCount] of calls) {
    const copies = Math.min(callCount, results.get(callId) ?? 0);
    if (copies < 2) {
      continue;
    }
    duplicatePairs++;
    maxCopies = Math.max(maxCopies, copies);
  }

  return { duplicatePairs, maxCopies };
};

const collectStats = (items: unknown[]): ConversationHistoryRepairStats => ({
  count: items.length,
  ...countDuplicatePairs(items),
});

const repairMetadata = (
  kind: ConversationHistoryRepair['kind'],
  before: unknown[],
  after: unknown[],
): ConversationHistoryRepair => {
  const beforeStats = collectStats(before);
  return {
    kind,
    removedItems: before.length - after.length,
    beforeCount: before.length,
    afterCount: after.length,
    duplicatePairsBefore: beforeStats.duplicatePairs,
    maxCopiesBefore: beforeStats.maxCopies,
  };
};

const collapseReplayedHistoryPrefixes = (
  input: unknown[],
): { history: unknown[]; repairs: ConversationHistoryRepair[] } => {
  let collapsed = input;
  const repairs: ConversationHistoryRepair[] = [];

  while (collapsed.length > 1) {
    const firstSignature = itemSignature(collapsed[0]);
    let replayStart = -1;

    for (let i = collapsed.length - 1; i > 0; i--) {
      if (itemSignature(collapsed[i]) !== firstSignature) {
        continue;
      }

      const prefixCallSignatures = collectCallSignatures(collapsed.slice(0, i));
      if (prefixCallSignatures.size === 0) {
        continue;
      }

      const suffixCallSignatures = collectCallSignatures(collapsed.slice(i));
      let allPrefixCallsReplayed = true;
      for (const signature of prefixCallSignatures) {
        if (!suffixCallSignatures.has(signature)) {
          allPrefixCallsReplayed = false;
          break;
        }
      }

      if (allPrefixCallsReplayed) {
        replayStart = i;
        break;
      }
    }

    if (replayStart === -1) {
      break;
    }

    const before = collapsed;
    collapsed = collapsed.slice(replayStart);
    repairs.push(repairMetadata('replayed_full_history_prefix', before, collapsed));
  }

  return { history: collapsed, repairs };
};

const repairDuplicatedToolPairs = (input: unknown[]): { history: unknown[]; repairs: ConversationHistoryRepair[] } => {
  const pairCounts = countDuplicatePairs(input);
  if (pairCounts.duplicatePairs === 0) {
    return { history: input, repairs: [] };
  }

  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  for (const item of input) {
    const raw = rawItem(item);
    const callId = callIdOf(raw);
    if (!callId) {
      continue;
    }
    const type = typeOf(raw);
    if (type === 'function_call') {
      calls.set(callId, (calls.get(callId) ?? 0) + 1);
    } else if (type === 'function_call_result') {
      results.set(callId, (results.get(callId) ?? 0) + 1);
    }
  }

  const duplicatedPairCallIds = new Set<string>();
  for (const [callId, callCount] of calls) {
    if (callCount > 1 && (results.get(callId) ?? 0) > 1) {
      duplicatedPairCallIds.add(callId);
    }
  }

  if (duplicatedPairCallIds.size === 0) {
    return { history: input, repairs: [] };
  }

  const keptCalls = new Set<string>();
  const keptResults = new Set<string>();
  const repaired = input.filter((item) => {
    const raw = rawItem(item);
    const callId = callIdOf(raw);
    if (!callId || !duplicatedPairCallIds.has(callId)) {
      return true;
    }

    const type = typeOf(raw);
    if (type === 'function_call') {
      if (keptCalls.has(callId)) {
        return false;
      }
      keptCalls.add(callId);
      return true;
    }

    if (type === 'function_call_result') {
      if (keptResults.has(callId)) {
        return false;
      }
      keptResults.add(callId);
      return true;
    }

    return true;
  });

  if (repaired.length === input.length) {
    return { history: input, repairs: [] };
  }

  return {
    history: repaired,
    repairs: [repairMetadata('duplicated_tool_call_result_pair', input, repaired)],
  };
};

export function repairConversationHistory(history: unknown[]): ConversationHistoryRepairResult {
  const statsBefore = collectStats(history);
  let repairedHistory = cloneHistory(history);
  const repairs: ConversationHistoryRepair[] = [];

  const prefixRepair = collapseReplayedHistoryPrefixes(repairedHistory);
  repairedHistory = prefixRepair.history;
  repairs.push(...prefixRepair.repairs);

  const pairRepair = repairDuplicatedToolPairs(repairedHistory);
  repairedHistory = pairRepair.history;
  repairs.push(...pairRepair.repairs);

  const statsAfter = collectStats(repairedHistory);
  return {
    history: repairedHistory,
    repaired: repairedHistory.length !== history.length,
    removedItems: history.length - repairedHistory.length,
    repairs,
    statsBefore,
    statsAfter,
  };
}
