import type { TurnId } from '../engine/index.js';
import type { TurnCompactionState } from '../engine/direct-types.js';
import type { Item } from '../model/index.js';
import type { Fact } from './facts.js';
import type { Turn, TurnRequest, StartedConversationTurn } from './direct-types.js';
import type { DirectQueueEnvironment } from './direct-queue-types.js';

/** The foreground owner exposes admission capabilities, never writable runtime state. */
export type CommandAdmission = {
  readonly closed: boolean;
  readonly active: (Turn & { turnId: TurnId; cancelled: boolean; stop(): Promise<void> }) | null;
  readonly completionHeld: TurnId | null;
  releaseCompletion(turnId: TurnId): void;
  newTurnId(): TurnId;
  environment(): DirectQueueEnvironment;
  start(
    request: TurnRequest,
    planned?: {
      readonly turnId: TurnId;
      readonly facts: readonly Fact[];
      readonly accepted?: true;
      readonly silent?: true;
      readonly compaction?: true;
      readonly retryNotice?: { readonly messageId: Item['id']; readonly text: string };
      readonly compactionState?: TurnCompactionState;
      readonly history?: readonly Item[];
    },
  ): StartedConversationTurn;
};
export type CommandOwner = {
  readonly commandId: string;
  readonly kind: import('./direct-command-types.js').DirectCommandOperation['kind'];
  readonly abort: AbortController;
  done?: Promise<unknown>;
};
