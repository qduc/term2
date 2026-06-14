export type ToolExecutionStatus = 'started' | 'completed' | 'failed' | 'approval_required' | 'aborted';

export interface SavedToolExecution {
  turnId: string;
  callId: string;
  toolName: string;
  arguments?: unknown;
  status: ToolExecutionStatus;
  output?: unknown;
  failureReason?: string;
  startedAt: string;
  completedAt?: string;
  historyItems?: unknown[];
}

export interface ToolLedgerReconcileResult {
  history: unknown[];
  addedCompletedPairs: number;
  droppedIncompleteCalls: number;
}

export interface ToolLedgerRecoverySummary {
  recoveredCallIds: string[];
  droppedCallIds: string[];
  message: string;
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const rawItem = (item: unknown): Record<string, unknown> | null => {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  return asRecord(record.rawItem) ?? record;
};

const clone = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
};

export const callIdOf = (item: unknown): string | null => {
  const raw = rawItem(item);
  const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id ?? raw?.toolCallId ?? raw?.id;
  return typeof callId === 'string' && callId ? callId : null;
};

const typeOf = (item: unknown): string => {
  const type = rawItem(item)?.type;
  return typeof type === 'string' ? type : '';
};

export const toolNameOf = (item: unknown): string => {
  const raw = rawItem(item);
  const name = raw?.name ?? asRecord(item)?.name;
  return typeof name === 'string' && name ? name : 'unknown';
};

const argumentsOf = (item: unknown): unknown => {
  const raw = rawItem(item);
  return raw?.arguments ?? raw?.args ?? asRecord(item)?.arguments ?? asRecord(item)?.args;
};

export const outputOf = (item: unknown): unknown => {
  const raw = rawItem(item);
  return raw?.output ?? asRecord(item)?.output;
};

const normalizedRawItem = (item: unknown): unknown => {
  const raw = rawItem(item);
  return raw ? clone(raw) : clone(item);
};

const normalizeAbortedHistoryItem = (item: unknown, isAbortedEntry: boolean): unknown => {
  if (!isAbortedEntry) {
    return clone(item);
  }

  const raw = rawItem(item);
  if (!raw) {
    return clone(item);
  }

  const type = typeof raw.type === 'string' ? raw.type : '';
  if (type !== 'function_call_output' && type !== 'function_call_output_result') {
    return clone(item);
  }

  const normalized = clone(raw) as Record<string, unknown>;
  normalized.type = 'tool_call_output_item';
  return normalized;
};

const turnNumberOf = (turnId: string | undefined): number | null => {
  if (typeof turnId !== 'string') {
    return null;
  }

  const match = /^turn-(\d+)$/.exec(turnId);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
};

const isUserMessage = (item: unknown): boolean => {
  const raw = rawItem(item);
  return raw?.role === 'user' && raw?.type === 'message';
};

const insertionIndexForEntry = (history: unknown[], entry: SavedToolExecution): number => {
  const turnNumber = turnNumberOf(entry.turnId);
  if (!turnNumber || turnNumber < 1) {
    return history.length;
  }

  let seenUserTurns = 0;
  for (let index = 0; index < history.length; index++) {
    if (!isUserMessage(history[index])) {
      continue;
    }

    seenUserTurns++;
    if (seenUserTurns === turnNumber + 1) {
      return index;
    }
  }

  return history.length;
};

const hasCallPair = (history: unknown[], callId: string): boolean => {
  let hasCall = false;
  let hasResult = false;
  for (const item of history) {
    if (callIdOf(item) !== callId) {
      continue;
    }
    const type = typeOf(item);
    if (type === 'function_call') {
      hasCall = true;
    } else if (
      type === 'function_call_result' ||
      type === 'function_call_output' ||
      type === 'function_call_output_result' ||
      type === 'tool_call_output_item'
    ) {
      hasResult = true;
    }
  }
  return hasCall && hasResult;
};

const hasRecoverableCallPair = (entry: SavedToolExecution): boolean =>
  Array.isArray(entry.historyItems) && entry.historyItems.length >= 2;

const isCompleteLedgerEntry = (entry: SavedToolExecution): boolean =>
  entry.status === 'completed' && hasRecoverableCallPair(entry);

export class ToolExecutionLedger {
  #entries: SavedToolExecution[] = [];
  #turnCounter = 0;
  #currentTurnId = 'turn-0';

  beginTurn(): string {
    this.#turnCounter++;
    this.#currentTurnId = `turn-${this.#turnCounter}`;
    return this.#currentTurnId;
  }

  /**
   * Returns the id of the turn currently in progress, or 'turn-0' if no turn
   * has begun yet. Used by the journal and logger to tag entries with a stable
   * turn identifier that survives approval continuations.
   */
  getCurrentTurnId(): string {
    return this.#currentTurnId;
  }

  import(entries: readonly SavedToolExecution[] | undefined): void {
    this.#entries = Array.isArray(entries) ? clone(entries) : [];
    this.#turnCounter = this.#entries.length;
    this.#currentTurnId = `turn-${this.#turnCounter}`;
  }

  export(): SavedToolExecution[] {
    return clone(this.#entries);
  }

  recordFunctionCall(item: unknown): void {
    if (typeOf(item) !== 'function_call') {
      return;
    }
    const callId = callIdOf(item);
    if (!callId) {
      return;
    }

    const existing = this.#entries.find((entry) => entry.callId === callId && entry.status !== 'completed');
    if (existing) {
      existing.toolName = toolNameOf(item);
      existing.arguments = argumentsOf(item);
      existing.status = 'started';
      if (!existing.historyItems || existing.historyItems.length === 0) {
        existing.historyItems = [normalizedRawItem(item)];
      }
      return;
    }

    this.#entries.push({
      turnId: this.#currentTurnId,
      callId,
      toolName: toolNameOf(item),
      arguments: argumentsOf(item),
      status: 'started',
      startedAt: new Date().toISOString(),
      historyItems: [normalizedRawItem(item)],
    });
  }

  recordFunctionResult(item: unknown): void {
    const type = typeOf(item);
    if (
      type !== 'function_call_result' &&
      type !== 'function_call_output' &&
      type !== 'function_call_output_result' &&
      type !== 'tool_call_output_item'
    ) {
      return;
    }
    const callId = callIdOf(item);
    if (!callId) {
      return;
    }

    let entry = [...this.#entries].reverse().find((candidate) => candidate.callId === callId);
    if (!entry) {
      entry = {
        turnId: this.#currentTurnId,
        callId,
        toolName: toolNameOf(item),
        status: 'started',
        startedAt: new Date().toISOString(),
        historyItems: [],
      };
      this.#entries.push(entry);
    }

    const callItem = entry.historyItems?.find((historyItem) => typeOf(historyItem) === 'function_call');
    const resultItem = normalizedRawItem(item);
    entry.status = 'completed';
    entry.output = outputOf(item);
    entry.completedAt = new Date().toISOString();
    entry.historyItems = callItem ? [callItem, resultItem] : [resultItem];
  }

  markOpenCallsAborted(reason: string): void {
    for (const entry of this.#entries) {
      if (entry.status !== 'started' && entry.status !== 'approval_required') {
        continue;
      }
      entry.status = 'aborted';
      entry.failureReason = reason;
      delete entry.historyItems;
    }
  }

  recordAbortedApproval(output: string, reason = 'Tool execution was not approved.', callId?: string): void {
    const candidates = [...this.#entries]
      .reverse()
      .filter((candidate) => candidate.status === 'started' || candidate.status === 'approval_required');

    const targets = callId ? candidates.filter((c) => c.callId === callId) : candidates;

    for (const entry of targets) {
      const callItem = entry.historyItems?.find((historyItem) => typeOf(historyItem) === 'function_call');
      if (!callItem) {
        entry.status = 'aborted';
        entry.failureReason = reason;
        continue;
      }

      entry.status = 'aborted';
      entry.failureReason = reason;
      entry.completedAt = new Date().toISOString();
      entry.output = output;
      entry.historyItems = [
        callItem,
        {
          type: 'function_call_output',
          callId: entry.callId,
          output,
        },
      ];
    }
  }

  getRecoverySummary(): ToolLedgerRecoverySummary | null {
    const currentTurnEntries = this.#entries.filter((entry) => entry.turnId === this.#currentTurnId);
    if (currentTurnEntries.length === 0) {
      return null;
    }

    const recoveredCallIds = currentTurnEntries
      .filter((entry) => isCompleteLedgerEntry(entry))
      .map((entry) => entry.callId);
    const droppedCallIds = currentTurnEntries
      .filter((entry) => entry.status !== 'completed')
      .map((entry) => entry.callId);

    if (recoveredCallIds.length === 0 && droppedCallIds.length === 0) {
      return null;
    }

    return {
      recoveredCallIds,
      droppedCallIds,
      message: createRecoveryMessage(recoveredCallIds.length, droppedCallIds.length),
    };
  }
}

const createRecoveryMessage = (completedPairs: number, incompleteCalls: number): string =>
  `Recovered ${completedPairs} completed tool call/result pair(s) from a previously interrupted turn. Dropped ${incompleteCalls} incomplete tool call(s); do not assume dropped calls completed.`;

export function reconcileHistoryWithToolLedger(
  history: readonly unknown[],
  ledger: readonly SavedToolExecution[] | undefined,
): ToolLedgerReconcileResult {
  const next = clone([...history]);
  const entries = Array.isArray(ledger) ? ledger : [];
  let addedCompletedPairs = 0;
  let droppedIncompleteCalls = 0;

  for (const entry of entries) {
    if (hasRecoverableCallPair(entry)) {
      if (hasCallPair(next, entry.callId)) {
        continue;
      }
      next.splice(
        insertionIndexForEntry(next, entry),
        0,
        ...entry.historyItems!.map((item: unknown) => normalizeAbortedHistoryItem(item, entry.status === 'aborted')),
      );
      if (entry.status === 'completed') {
        addedCompletedPairs++;
      }
      continue;
    }

    if (entry.status !== 'completed' && entry.status !== 'started' && entry.status !== 'approval_required') {
      droppedIncompleteCalls++;
    }
  }

  return { history: next, addedCompletedPairs, droppedIncompleteCalls };
}
