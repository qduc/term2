import type { PendingApproval } from '../../contracts/conversation.js';

export type NestedApprovalPolicyResult = 'auto_approve' | 'prompt' | 'unknown' | 'error' | 'interceptor_denied';
export type NestedApprovalDecision = { readonly answer: string; readonly rejectionReason?: string };

export type NestedApprovalRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly graphIdentity: object;
  readonly outerRunId: string;
  readonly nestedCallId: string;
  readonly toolName: string;
  readonly preparedArguments: unknown;
  readonly authorityContext: unknown;
  readonly approval: PendingApproval;
  readonly signal: AbortSignal;
  readonly revalidate: () => Promise<NestedApprovalPolicyResult>;
  readonly grant: (decision: NestedApprovalDecision) => void;
  readonly dispatch: () => Promise<unknown>;
};

export type NestedApprovalSnapshot = Omit<
  NestedApprovalRequest,
  'signal' | 'revalidate' | 'grant' | 'dispatch' | 'graphIdentity'
>;
export type NestedApprovalResolution =
  | { readonly kind: 'approved'; readonly result: unknown }
  | { readonly kind: 'denied'; readonly message: string };
export type NestedApprovalDecisionResult = { readonly kind: 'accepted' } | { readonly kind: 'stale' };

type Entry = {
  request: NestedApprovalRequest;
  resolve: (resolution: NestedApprovalResolution) => void;
  state: 'pending' | 'deciding' | 'executing';
  preparedArgumentsFingerprint: string;
};

const denial = (reason?: string): NestedApprovalResolution => ({
  kind: 'denied',
  message: reason ? "Tool execution was not approved. User's reason: " + reason : 'Tool execution was not approved.',
});

/** Session-owned request/decision owner for a live run_code worker. */
export class NestedApprovalOwner {
  #pending = new Map<string, Entry>();
  #displayed: string | null = null;
  #graphIdentity: object | null = null;
  #closed = false;
  #observer: ((snapshot: NestedApprovalSnapshot | null) => void) | null = null;

  constructor(private readonly sessionId?: string) {}

  bindGraph(graphIdentity: object): void {
    this.#graphIdentity = graphIdentity;
  }

  subscribe(observer: ((snapshot: NestedApprovalSnapshot | null) => void) | null): () => void {
    this.#observer = observer;
    observer?.(this.getSnapshot());
    return () => {
      if (this.#observer === observer) this.#observer = null;
    };
  }

  getSnapshot(): NestedApprovalSnapshot | null {
    const entry = this.#displayed ? this.#pending.get(this.#displayed) : undefined;
    if (!entry) return null;
    const { request } = entry;
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      outerRunId: request.outerRunId,
      nestedCallId: request.nestedCallId,
      toolName: request.toolName,
      preparedArguments: cloneSnapshotValue(request.preparedArguments),
      authorityContext: cloneSnapshotValue(request.authorityContext),
      approval: cloneSnapshotValue(request.approval),
    };
  }

  request(request: NestedApprovalRequest): Promise<NestedApprovalResolution> {
    if (
      this.#closed ||
      (this.sessionId !== undefined && request.sessionId !== this.sessionId) ||
      request.signal.aborted ||
      this.#pending.has(request.requestId) ||
      (this.#graphIdentity && request.graphIdentity !== this.#graphIdentity)
    ) {
      return Promise.resolve(denial());
    }
    return new Promise<NestedApprovalResolution>((resolve) => {
      const entry: Entry = {
        request,
        resolve,
        state: 'pending',
        preparedArgumentsFingerprint: fingerprint(request.preparedArguments),
      };
      this.#pending.set(request.requestId, entry);
      request.signal.addEventListener('abort', () => this.#settle(request.requestId, denial()), { once: true });
      if (this.#displayed === null) this.#displayed = request.requestId;
      this.#publish();
    });
  }

  decide(requestId: string, decision: NestedApprovalDecision): Promise<NestedApprovalDecisionResult> {
    const entry = this.#pending.get(requestId);
    if (!entry || this.#displayed !== requestId || entry.state !== 'pending') return Promise.resolve({ kind: 'stale' });
    entry.state = 'deciding';
    void this.#finishDecision(requestId, entry, decision);
    return Promise.resolve({ kind: 'accepted' });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const requestId of [...this.#pending.keys()]) this.#settle(requestId, denial());
    this.#displayed = null;
    this.#publish();
  }

  #settle(requestId: string, resolution: NestedApprovalResolution): void {
    const entry = this.#pending.get(requestId);
    if (!entry) return;
    this.#remove(requestId);
    entry.resolve(resolution);
    this.#publish();
  }

  #remove(requestId: string): Entry | undefined {
    const entry = this.#pending.get(requestId);
    if (!entry) return undefined;
    this.#pending.delete(requestId);
    if (this.#displayed === requestId) {
      this.#displayed = null;
      const next = this.#pending.keys().next().value as string | undefined;
      if (next) this.#displayed = next;
    }
    this.#publish();
    return entry;
  }

  async #finishDecision(requestId: string, entry: Entry, decision: NestedApprovalDecision): Promise<void> {
    if (decision.answer !== 'y' && !decision.answer.startsWith('allow-') && !decision.answer.startsWith('docker-')) {
      this.#settle(requestId, denial(decision.rejectionReason));
      return;
    }
    let policy: NestedApprovalPolicyResult;
    try {
      policy = await entry.request.revalidate();
    } catch {
      policy = 'error';
    }
    // Keep this final check adjacent to grant/dispatch: no await can reopen the race.
    if (
      this.#closed ||
      this.#pending.get(requestId) !== entry ||
      entry.request.signal.aborted ||
      (this.#graphIdentity && entry.request.graphIdentity !== this.#graphIdentity) ||
      fingerprint(entry.request.preparedArguments) !== entry.preparedArgumentsFingerprint ||
      (policy !== 'auto_approve' && policy !== 'prompt')
    ) {
      this.#settle(requestId, denial());
      return;
    }
    // From this point cancellation cannot rewrite the result: the capability
    // has been revalidated and dispatch is already beginning. This is the
    // approve-wins half of the cancellation race.
    entry.state = 'executing';
    this.#remove(requestId);
    try {
      entry.request.grant(decision);
      const dispatch = entry.request.dispatch();
      entry.resolve({ kind: 'approved', result: await dispatch });
    } catch (error) {
      entry.resolve(denial(error instanceof Error ? error.message : String(error)));
    }
  }

  #publish(): void {
    this.#observer?.(this.getSnapshot());
  }
}

function cloneSnapshotValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
