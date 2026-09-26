import type { ProviderInputItem } from '../../contracts/provider-input.js';

export type TurnInputOutcome = 'admitted' | 'released' | 'retracted';

/** A user message waiting for the running turn's next request boundary. */
type PendingInput = {
  readonly id?: string;
  readonly items: readonly ProviderInputItem[];
  readonly resolve: (outcome: TurnInputOutcome) => void;
};

export type TurnInputDiagnostic = (message: string, meta: Record<string, unknown>) => void;

/**
 * Owns the pending-input mailbox and its turn/segment settlement rules.
 *
 * Segment state only covers a running or paused segment. The caller-owned
 * open-turn state also keeps inputs steerable in gaps where no segment exists,
 * such as startup before the first request or retry backoff. Only the caller
 * that opened the turn knows those gaps still belong to it.
 */
export class TurnInputMailbox {
  #pending: PendingInput[] = [];
  #turnOpen = false;
  #segmentInFlight = false;
  /** A paused segment (for example, awaiting approval) can resume at a boundary. */
  #segmentPaused = false;
  readonly #diagnostic?: TurnInputDiagnostic;

  constructor(diagnostic?: TurnInputDiagnostic) {
    this.#diagnostic = diagnostic;
  }

  openTurn(): void {
    this.#release({ reason: 'superseded_by_new_turn' });
    this.#turnOpen = true;
    this.#segmentPaused = false;
  }

  closeTurn(): void {
    this.#turnOpen = false;
    this.#segmentPaused = false;
    this.#release({ reason: 'turn_closed' });
  }

  abortTurn(): void {
    this.#turnOpen = false;
    this.#segmentPaused = false;
    this.#release({ reason: 'aborted' });
  }

  startStream(): void {
    this.#segmentPaused = false;
    if (!this.#turnOpen) this.#release({ reason: 'superseded_by_new_turn' });
  }

  startSegment(): void {
    this.#segmentInFlight = true;
    this.#segmentPaused = false;
  }

  settleSegment(input: { readonly paused: boolean; readonly reason: Record<string, unknown> }): void {
    this.#segmentInFlight = false;
    this.#segmentPaused = input.paused;
    if (input.paused || this.#turnOpen) return;
    this.#release(input.reason);
  }

  offer(items: readonly ProviderInputItem[], options?: { id?: string }): Promise<TurnInputOutcome> {
    if (items.length === 0 || (!this.#turnOpen && !this.#segmentInFlight && !this.#segmentPaused)) {
      return Promise.resolve('released');
    }
    return new Promise<TurnInputOutcome>((resolve) => {
      this.#pending.push({ id: options?.id, items, resolve });
    });
  }

  enqueueInternal(item: ProviderInputItem): void {
    this.#pending.push({ items: [item], resolve: () => undefined });
  }

  retract(id: string): boolean {
    const index = this.#pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const [item] = this.#pending.splice(index, 1);
    item!.resolve('retracted');
    return true;
  }

  edit(id: string, items: readonly ProviderInputItem[]): boolean {
    const index = this.#pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.#pending[index] = { ...this.#pending[index]!, items };
    return true;
  }

  /** Drain synchronously in FIFO order; the caller supplies history/event effects. */
  admitAtRequestBoundary(append: (item: ProviderInputItem) => void, turnCount: number): void {
    if (this.#pending.length === 0) return;
    const admitted = this.#pending;
    this.#pending = [];
    this.#diagnostic?.('Steer admitted at request boundary', { admitted: admitted.length, turnCount });
    for (const entry of admitted) {
      for (const item of entry.items) append(item);
      entry.resolve('admitted');
    }
  }

  #release(reason: Record<string, unknown>): void {
    const pending = this.#pending;
    this.#pending = [];
    if (pending.length > 0) this.#diagnostic?.('Steer released at run end', { released: pending.length, ...reason });
    for (const entry of pending) entry.resolve('released');
  }
}
