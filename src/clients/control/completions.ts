/** Local callback delivery, correlated by admission message/turn identities.
 * A command acknowledgement is never treated as a terminal answer. No callbacks
 * enter the protocol and this table never writes Session/domain state.
 */
import { setImmediate } from 'node:timers';
import type { WireAdmission, WireEvent, WireSnapshot } from '../../protocol/wire.js';
import type { BridgeOutcome } from './transport.js';
import { submissionOutcome } from './submission-result.js';

type Admission = Exclude<WireAdmission, { readonly kind: 'duplicate' | 'rejected' }>;
export interface ControlDelivery {
  readonly complete?: (outcome: BridgeOutcome) => void;
  readonly onSteerSettled?: () => void;
  admission?: Admission;
  turnId?: string;
  seenQueued: boolean;
  steerSettled: boolean;
  completed: boolean;
}
interface Observation {
  readonly messageIds: Set<string>;
  outcome?: BridgeOutcome;
}

function callback(action: (() => void) | undefined): void {
  // Compatibility callbacks are observers; a faulty observer must not stop fanout/cleanup.
  try {
    action?.();
  } catch {
    /* no runtime effects belong to this callback */
  }
}

function terminal(state: WireSnapshot, ended: NonNullable<WireSnapshot['terminal']>): BridgeOutcome {
  if (ended.outcome !== 'completed') return { state: 'interrupted' };
  if (ended.finalText !== undefined)
    return ended.finalText === null ? { state: 'pending' } : { state: 'final', text: ended.finalText };
  // Last completed assistant message is the final answer, not an earlier tool preface
  // or another turn's streamed draft. Never concatenate model-step identities.
  const messages = state.messages.filter(
    (message) => message.turnId === ended.turnId && message.role === 'assistant' && !message.draft,
  );
  const final = messages.at(-1);
  return final ? { state: 'final', text: final.text } : { state: 'pending' };
}

/** Retains observations only while callbacks or an in-flight admission need them.
 * It tolerates turn/interaction/terminal events arriving before send() resolves.
 */
export class ControlCompletions {
  readonly #deliveries = new Set<ControlDelivery>();
  readonly #observations = new Map<string, Observation>();

  register(callbacks: Pick<ControlDelivery, 'complete' | 'onSteerSettled'>): ControlDelivery {
    const delivery: ControlDelivery = { ...callbacks, seenQueued: false, steerSettled: false, completed: false };
    this.#deliveries.add(delivery);
    return delivery;
  }

  admit(delivery: ControlDelivery, admission: Admission, replayed: boolean, state: WireSnapshot): void {
    if (!this.#deliveries.has(delivery)) {
      // Detach may precede the ack. Settle only now, after the receipt can be
      // installed by the transport, rather than leaving a replay key pinned.
      this.#settleSteer(delivery);
      return;
    }
    delivery.admission = admission;
    delivery.turnId = admission.turnId ?? state.messages.find((item) => item.id === admission.messageId)?.turnId;
    if (admission.kind !== 'steering') this.#settleSteer(delivery);
    this.#update(delivery, state);
    const live =
      state.queue.some((item) => item.messageId === admission.messageId) ||
      (delivery.turnId !== undefined &&
        (state.activeTurnId === delivery.turnId ||
          state.pendingInteractions.some((item) => item.turnId === delivery.turnId)));
    if (replayed && !live && !state.submissions?.some((item) => item.clientRequestId === admission.clientRequestId)) {
      // Only the actual matching terminal can establish completion. An older
      // duplicate absent from the retained terminal remains uncertain, not final.
      this.#complete(delivery, { state: 'interrupted' });
      this.#settleSteer(delivery);
    }
    if (delivery.completed && delivery.steerSettled) this.#deliveries.delete(delivery);
    this.#prune();
  }

  reject(delivery: ControlDelivery): void {
    this.#complete(delivery, { state: 'rejected' });
    this.#settleSteer(delivery);
    this.#deliveries.delete(delivery);
    this.#prune();
  }

  uncertain(delivery: ControlDelivery): void {
    this.#complete(delivery, { state: 'interrupted' });
    this.#settleSteer(delivery);
    this.#deliveries.delete(delivery);
    this.#prune();
  }

  observe(event: WireEvent, state: WireSnapshot): void {
    if (this.#deliveries.size === 0) return;
    if (event.turnId !== null) {
      let observation = this.#observations.get(event.turnId);
      if (!observation) {
        observation = { messageIds: new Set() };
        this.#observations.set(event.turnId, observation);
      }
      if (event.type === 'turn_started') {
        for (const message of event.payload.input) observation.messageIds.add(message.id);
      }
      if (event.type === 'message' && event.payload.message.role === 'user') {
        observation.messageIds.add(event.payload.message.id);
      }
      if (event.type === 'interaction_opened') observation.outcome ??= { state: 'awaiting_approval' };
      if (event.type === 'turn_ended')
        observation.outcome = terminal(state, { turnId: event.turnId, ...event.payload });
    }
    for (const delivery of this.#deliveries) this.#update(delivery, state);
    this.#prune();
  }

  close(): void {
    for (const delivery of this.#deliveries) {
      this.#complete(delivery, { state: 'interrupted' });
      if (delivery.admission) this.#settleSteer(delivery);
    }
    this.#deliveries.clear();
    this.#observations.clear();
  }

  #update(delivery: ControlDelivery, state: WireSnapshot): void {
    const admission = delivery.admission;
    if (!admission) return;
    const record = state.submissions?.find(
      (item) => item.clientRequestId === admission.clientRequestId && item.messageId === admission.messageId,
    );
    if (record) {
      delivery.turnId = record.turnId;
      if (record.stage !== 'queued' && record.stage !== 'pending_steer') this.#settleSteer(delivery);
      const outcome = submissionOutcome(record, state);
      if (outcome.state !== 'pending') this.#complete(delivery, outcome);
      if (!delivery.complete) delivery.completed = true;
      if (delivery.completed && delivery.steerSettled) this.#deliveries.delete(delivery);
      return;
    }
    const latest = state.admissions.find((item) => item.clientRequestId === admission.clientRequestId);
    const admitted = latest?.kind === 'duplicate' ? latest.original : latest;
    if (admitted?.kind === 'rejected') {
      this.reject(delivery);
      return;
    }
    delivery.turnId = admitted?.turnId ?? delivery.turnId;
    const matching = [...this.#observations].find(([, item]) => item.messageIds.has(admission.messageId));
    delivery.turnId = matching?.[0] ?? delivery.turnId;
    const observation = delivery.turnId ? this.#observations.get(delivery.turnId) : undefined;
    const queued = state.queue.some((item) => item.messageId === admission.messageId);
    if (queued) delivery.seenQueued = true;
    if (matching || (observation?.outcome && observation.outcome.state !== 'pending')) this.#settleSteer(delivery);
    const pending =
      state.pendingInteractions.some((item) => item.turnId === delivery.turnId) ||
      state.pendingBudgets?.some((item) => item.turnId === delivery.turnId);
    if (state.terminal && state.terminal.turnId === delivery.turnId) {
      const outcome = terminal(state, state.terminal);
      if (outcome.state !== 'pending') this.#complete(delivery, outcome);
      this.#settleSteer(delivery);
    } else if (observation?.outcome && observation.outcome.state !== 'pending')
      this.#complete(delivery, observation.outcome);
    else if (pending) this.#complete(delivery, { state: 'awaiting_approval' });
    if (!delivery.complete) delivery.completed = true;
    if (delivery.completed && delivery.steerSettled) this.#deliveries.delete(delivery);
  }

  #settleSteer(delivery: ControlDelivery): void {
    if (delivery.steerSettled) return;
    delivery.steerSettled = true;
    // Socket installs its replay receipt after awaiting the port's admission.
    // A racing terminal can precede that ack; run settlement after that await
    // chain, or the transport would mark an already-settled steer pending.
    setImmediate(() => callback(delivery.onSteerSettled));
  }

  #complete(delivery: ControlDelivery, outcome: BridgeOutcome): void {
    if (delivery.completed) return;
    delivery.completed = true;
    callback(delivery.complete ? () => delivery.complete!(outcome) : undefined);
  }

  #prune(): void {
    // Before ack, identities are not known yet: preserve those few racing events.
    if ([...this.#deliveries].some((item) => !item.admission)) return;
    for (const [turnId, observation] of this.#observations) {
      const needed = [...this.#deliveries].some(
        (item) =>
          item.turnId === turnId ||
          (item.admission !== undefined && observation.messageIds.has(item.admission.messageId)),
      );
      if (!needed) this.#observations.delete(turnId);
    }
  }
}
