/** Standalone, in-memory experiment. No imports from the Term2 runtime. */
export type Call = {
  id: string;
  name: string;
  approval?: boolean;
  background?: 'session' | 'conversation';
};
export type Item =
  | { role: 'user'; id: string; text: string }
  | { role: 'assistant'; text: string; calls: Call[] }
  | { role: 'tool'; id: string; outcome: string }
  | { role: 'notification'; id: string; text: string };
export type ModelReply = { text: string; calls: Call[]; responseId?: string };
export type ModelRequest = { history: Item[]; previousResponseId?: string };
export type ToolOutcome = { kind: 'known'; value: string } | { kind: 'unknown'; reason: string };
/** Result knowledge and physical stop evidence are independent facts. */
export type Fact =
  | { kind: 'model-result'; reply: ModelReply }
  | { kind: 'model-error'; error: ProviderFailure }
  | { kind: 'tool-result'; outcome: ToolOutcome }
  | { kind: 'stopped' }
  | { kind: 'stop-unproven'; reason: string };
export type Ports = {
  model(request: ModelRequest, signal: AbortSignal, report: (fact: Fact) => void): void;
  tool(call: Call, executionId: string, signal: AbortSignal, report: (fact: Fact) => void): void;
};
export class ProviderFailure extends Error {
  constructor(public kind: 'transient' | 'invalid-chain' | 'fatal', message: string) {
    super(message);
  }
}
export type Command =
  | { type: 'submit'; id: string; text: string; steer?: boolean }
  | { type: 'edit'; id: string; text: string }
  | { type: 'retract'; id: string }
  | { type: 'approve'; token: number; allow: boolean }
  | { type: 'retry'; token: number }
  | { type: 'reconcile'; token: number; outcome: string }
  | { type: 'cancel'; turn: number }
  | { type: 'rollover' };
type Internal = { type: 'fact'; token: number; fact: Fact };
type Completion =
  | { type: 'model-result'; token: number; reply: ModelReply }
  | { type: 'model-error'; token: number; error: unknown }
  | { type: 'tool-result'; token: number; outcome: ToolOutcome }
  | { type: 'job-result'; token: number; outcome: ToolOutcome };
type Submission = {
  id: string;
  text: string;
  target?: number;
  status: 'queued' | 'consumed' | 'completed' | 'cancelled' | 'failed' | 'retracted';
  turn?: number;
};
type Phase =
  | { kind: 'model'; token: number }
  | { kind: 'retry'; token: number }
  | { kind: 'approval'; token: number }
  | { kind: 'tool'; token: number }
  | { kind: 'unknown'; token: number };
type Turn = { id: number; phase?: Phase; calls: Call[]; next: number; seen: Set<string> };
type Execution = {
  token: number;
  id: string;
  kind: 'model' | 'tool';
  turn: number;
  origin: number;
  scope: 'turn' | 'session' | 'conversation';
  abort: AbortController;
  stopped: boolean;
  result?: Extract<Fact, { kind: 'model-result' | 'model-error' | 'tool-result' }>;
};
export type Event = {
  seq: number;
  session: number;
  turn?: number;
  type: string;
  detail: Record<string, unknown>;
};

export class Conversation {
  #ports: Ports;
  #mail: (Command | Internal)[] = [];
  #draining = false;
  #submissions = new Map<string, Submission>();
  #history: Item[] = [];
  #turn?: Turn;
  #executions = new Map<number, Execution>();
  #observers = new Set<(event: Event) => void>();
  #events: Event[] = [];
  #serial = 0;
  #session = 1;
  #anchor?: string;

  constructor(ports: Ports) {
    this.#ports = ports;
  }

  /** Commands are copied on admission; reentrant sends are queued, never nested. */
  send(command: Command): void {
    this.#post(structuredClone(command));
  }

  observe(observer: (event: Event) => void): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  snapshot() {
    return structuredClone({
      session: this.#session,
      turn: this.#turn && { id: this.#turn.id, phase: this.#turn.phase?.kind, token: this.#turn.phase?.token },
      submissions: [...this.#submissions.values()],
      history: this.#history,
      jobs: [...this.#executions.values()]
        .filter((work) => work.scope !== 'turn')
        .map(({ token, id, origin, scope }) => ({ token, id, origin, survive: scope === 'conversation' })),
      executions: [...this.#executions.values()].map(({ token, id, kind, turn, origin, scope, stopped, result }) => ({
        token,
        id,
        kind,
        turn,
        origin,
        scope,
        stopped,
        hasResult: !!result,
      })),
      events: this.#events,
    });
  }

  #emit(type: string, detail: Record<string, unknown> = {}): void {
    const event = structuredClone({
      seq: this.#events.length + 1,
      session: this.#session,
      turn: this.#turn?.id,
      type,
      detail,
    });
    this.#events.push(event);
    for (const observer of [...this.#observers]) {
      // Consumers cannot corrupt the authoritative journal or interrupt settlement.
      try {
        observer(structuredClone(event));
      } catch {
        /* observation is best effort */
      }
    }
  }

  #post(message: Command | Internal): void {
    this.#mail.push(message);
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#mail.length) {
        this.#receive(this.#mail.shift()!);
        this.#startQueued();
      }
    } finally {
      this.#draining = false;
    }
  }

  #receive(message: Command | Internal): void {
    switch (message.type) {
      case 'submit': {
        if (this.#submissions.has(message.id))
          return this.#emit('rejected', { command: message.type, id: message.id, reason: 'duplicate-id' });
        const submission: Submission = {
          id: message.id,
          text: message.text,
          status: 'queued',
          target: message.steer ? this.#turn?.id : undefined,
        };
        this.#submissions.set(message.id, submission);
        this.#emit('accepted', { id: message.id, target: submission.target });
        return;
      }
      case 'edit':
      case 'retract': {
        const submission = this.#submissions.get(message.id);
        if (submission?.status !== 'queued')
          return this.#emit('rejected', { command: message.type, id: message.id, reason: 'not-queued' });
        if (message.type === 'edit') {
          submission.text = message.text;
          this.#emit('edited', { id: message.id });
        } else {
          submission.status = 'retracted';
          this.#emit('settled', { id: message.id, status: 'retracted' });
        }
        return;
      }
      case 'cancel':
        if (message.turn !== this.#turn?.id) return this.#emit('stale', { command: message.type, turn: message.turn });
        return this.#finish('cancelled');
      case 'rollover': {
        if (this.#turn) this.#finish('cancelled');
        this.#history = [];
        this.#anchor = undefined;
        this.#session++;
        for (const work of this.#executions.values()) {
          if (work.scope === 'session' && work.origin !== this.#session) {
            this.#emit('job-detached', { id: work.id, token: work.token, outcome: 'unknown', origin: work.origin });
            work.abort.abort();
            this.#advanceExecution(work);
          }
        }
        this.#emit('rollover');
        return;
      }
      case 'fact':
        return this.#acceptFact(message.token, message.fact);
      default:
        this.#workflow(message);
    }
  }

  #consume(submission: Submission): void {
    submission.status = 'consumed';
    submission.turn = this.#turn!.id;
    this.#history.push({ role: 'user', id: submission.id, text: submission.text });
    this.#emit('consumed', { id: submission.id });
  }

  #register(token: number, id: string, kind: Execution['kind'], scope: Execution['scope']): Execution {
    const work: Execution = {
      token,
      id,
      kind,
      turn: this.#turn!.id,
      origin: this.#session,
      scope,
      abort: new AbortController(),
      stopped: false,
    };
    this.#executions.set(token, work);
    return work;
  }

  #dispatch(work: Execution, start: (report: (fact: Fact) => void) => void): void {
    const report = (fact: Fact) =>
      this.#post({
        type: 'fact',
        token: work.token,
        fact:
          fact.kind === 'model-error'
            ? { kind: 'model-error', error: new ProviderFailure(fact.error.kind, fact.error.message) }
            : structuredClone(fact),
      });
    try {
      start(report);
    } catch (error) {
      // A throwing start may have launched work. It is not evidence of quiescence.
      report(
        work.kind === 'model'
          ? { kind: 'model-error', error: new ProviderFailure('fatal', String(error)) }
          : { kind: 'tool-result', outcome: { kind: 'unknown', reason: String(error) } },
      );
      report({ kind: 'stop-unproven', reason: 'adapter threw during dispatch' });
    }
  }

  #retired(work: Execution): boolean {
    return work.scope === 'turn'
      ? work.turn !== this.#turn?.id
      : work.scope === 'session' && work.origin !== this.#session;
  }

  #acceptFact(token: number, fact: Fact): void {
    const work = this.#executions.get(token);
    if (!work) return this.#emit('stale', { command: 'fact', token });
    if (fact.kind === 'stop-unproven') {
      return this.#emit('stop-unproven', { token, id: work.id, reason: fact.reason });
    }
    if (fact.kind === 'stopped') {
      work.stopped = true;
      this.#emit('execution-stopped', { token, id: work.id });
    } else {
      if (work.result || (work.kind === 'tool') !== (fact.kind === 'tool-result')) {
        return this.#emit('rejected-fact', { token, kind: fact.kind });
      }
      work.result = fact;
      this.#emit('execution-result', { token, id: work.id, fact });
    }
    this.#advanceExecution(work);
  }

  #advanceExecution(work: Execution): void {
    if (!work.stopped) return;
    if (this.#retired(work)) {
      this.#executions.delete(work.token);
      this.#emit('execution-released', { token: work.token, id: work.id });
      return;
    }
    const result = work.result;
    if (!result) return;
    this.#executions.delete(work.token);
    if (work.scope !== 'turn' && result.kind === 'tool-result') {
      const outcome = result.outcome;
      const text = outcome.kind === 'known' ? outcome.value : `unknown: ${outcome.reason}`;
      this.#history.push({ role: 'notification', id: work.id, text });
      this.#emit('job-completed', { id: work.id, origin: work.origin, outcome });
    } else if (result.kind === 'model-result') {
      this.#workflow({ type: 'model-result', token: work.token, reply: result.reply });
    } else if (result.kind === 'model-error') {
      this.#workflow({ type: 'model-error', token: work.token, error: result.error });
    } else {
      this.#workflow({ type: 'tool-result', token: work.token, outcome: result.outcome });
    }
  }

  #startQueued(): void {
    if (this.#turn) return;
    // Revocation is not stop evidence. A retired execution blocks replacement work.
    if ([...this.#executions.values()].some((work) => this.#retired(work) && !work.stopped)) return;
    const submission = [...this.#submissions.values()].find((item) => item.status === 'queued');
    if (!submission) return;
    this.#turn = { id: ++this.#serial, calls: [], next: 0, seen: new Set() };
    this.#emit('turn-started', { id: submission.id });
    this.#consume(submission);
    this.#requestModel();
  }

  #requestModel(): void {
    const turn = this.#turn!;
    for (const item of this.#submissions.values()) {
      if (item.status === 'queued' && item.target === turn.id) this.#consume(item);
    }
    const token = ++this.#serial;
    turn.phase = { kind: 'model', token };
    const request = structuredClone({ history: this.#history, previousResponseId: this.#anchor });
    this.#emit('model-requested', { token, chained: !!this.#anchor, items: request.history.length });
    const work = this.#register(token, `model:${token}`, 'model', 'turn');
    this.#dispatch(work, (report) => this.#ports.model(request, work.abort.signal, report));
  }

  #workflow(
    message: Exclude<
      Command | Completion,
      { type: 'submit' | 'edit' | 'retract' | 'cancel' | 'rollover' | 'job-result' }
    >,
  ): void {
    const turn = this.#turn;
    const phase = turn?.phase;
    const expected = {
      'model-result': 'model',
      'model-error': 'model',
      'tool-result': 'tool',
      approve: 'approval',
      retry: 'retry',
      reconcile: 'unknown',
    }[message.type];
    if (!turn || !phase || phase.token !== message.token || phase.kind !== expected) {
      return this.#emit('stale', { command: message.type, token: message.token });
    }
    switch (message.type) {
      case 'model-error': {
        // A failed attempt never supplies a new anchor. Drop prior continuity too.
        this.#anchor = undefined;
        const failure = message.error;
        if (failure instanceof ProviderFailure && failure.kind !== 'fatal') {
          turn.phase = { kind: 'retry', token: ++this.#serial };
          this.#emit('retry-needed', { token: turn.phase.token, cause: failure.kind, message: failure.message });
        } else {
          this.#emit('provider-failed', { message: String(failure) });
          this.#finish('failed');
        }
        return;
      }
      case 'retry':
        return this.#requestModel();
      case 'model-result': {
        const { reply } = message;
        if (
          new Set(reply.calls.map((call) => call.id)).size !== reply.calls.length ||
          reply.calls.some((call) => turn.seen.has(call.id))
        ) {
          this.#emit('provider-failed', { message: 'duplicate call IDs in model response' });
          return this.#finish('failed');
        }
        this.#anchor = reply.responseId;
        this.#history.push({ role: 'assistant', text: reply.text, calls: reply.calls });
        turn.calls = reply.calls;
        for (const call of reply.calls) turn.seen.add(call.id);
        turn.next = 0;
        this.#emit('model-completed', { token: message.token, calls: reply.calls.length });
        if (!reply.calls.length) return this.#finish('completed');
        return this.#nextTool();
      }
      case 'approve':
        this.#emit('approval-resolved', { token: message.token, allow: message.allow });
        if (!message.allow) {
          this.#toolRecord('denied');
          return this.#nextTool();
        }
        return this.#runTool();
      case 'tool-result':
        if (message.outcome.kind === 'unknown') {
          turn.phase = { kind: 'unknown', token: ++this.#serial };
          this.#anchor = undefined;
          this.#emit('reconciliation-needed', {
            token: turn.phase.token,
            call: turn.calls[turn.next].id,
            reason: message.outcome.reason,
          });
          return;
        }
        this.#toolRecord(message.outcome.value);
        return this.#nextTool();
      case 'reconcile':
        this.#emit('reconciled', { token: message.token, outcome: message.outcome });
        this.#toolRecord(message.outcome);
        return this.#nextTool();
    }
  }

  #toolRecord(outcome: string): void {
    const turn = this.#turn!;
    const call = turn.calls[turn.next++];
    this.#history.push({ role: 'tool', id: call.id, outcome });
    this.#emit('tool-settled', { call: call.id, outcome });
  }

  #nextTool(): void {
    const turn = this.#turn!;
    if (turn.next === turn.calls.length) return this.#requestModel();
    const call = turn.calls[turn.next];
    if (call.approval) {
      turn.phase = { kind: 'approval', token: ++this.#serial };
      this.#emit('approval-needed', { token: turn.phase.token, call: call.id });
    } else {
      this.#runTool();
    }
  }

  #runTool(): void {
    const turn = this.#turn!;
    const call = structuredClone(turn.calls[turn.next]);
    // Routing is actor-owned; the adapter may mutate its disposable call copy.
    const background = call.background;
    const token = ++this.#serial;
    const id = `${turn.id}/${call.id}`;
    const work = this.#register(token, id, 'tool', background ?? 'turn');
    if (background) {
      this.#emit('job-started', { id, token });
    } else {
      turn.phase = { kind: 'tool', token };
      this.#emit('tool-started', { id, token });
    }
    this.#dispatch(work, (report) => this.#ports.tool(call, id, work.abort.signal, report));
    if (background) {
      this.#toolRecord(`background:${id}`);
      this.#nextTool();
    }
  }

  #finish(status: 'completed' | 'cancelled' | 'failed'): void {
    const turn = this.#turn!;
    const phase = turn.phase;
    if (status !== 'completed') {
      this.#anchor = undefined;
      // Finish every assistant/tool pair. A dispatched effect is never called failed.
      while (turn.next < turn.calls.length) {
        const result = phase?.kind === 'tool' ? this.#executions.get(phase.token)?.result : undefined;
        const known =
          result?.kind === 'tool-result' && result.outcome.kind === 'known' ? result.outcome.value : undefined;
        this.#toolRecord(known ?? (phase?.kind === 'tool' || phase?.kind === 'unknown' ? 'unknown' : 'not-executed'));
        // Only the first unfinished call could have been dispatched.
        if (phase?.kind === 'tool' || phase?.kind === 'unknown') {
          while (turn.next < turn.calls.length) this.#toolRecord('not-executed');
        }
      }
    }
    for (const submission of this.#submissions.values()) {
      if (submission.status === 'consumed' && submission.turn === turn.id) {
        submission.status = status;
        this.#emit('settled', { id: submission.id, status });
      } else if (submission.status === 'queued' && submission.target === turn.id) {
        submission.target = undefined;
        this.#emit('steer-returned', { id: submission.id });
      }
    }
    this.#emit('turn-finished', { status });
    this.#turn = undefined;
    // Logical revocation precedes cooperative cancellation (which may be ignored).
    if (phase?.kind === 'tool' || phase?.kind === 'model') {
      const work = this.#executions.get(phase.token);
      if (work) {
        work.abort.abort();
        this.#emit('stop-requested', { token: work.token, id: work.id });
        this.#advanceExecution(work);
      }
    }
  }
}
