/** Reuse memory authority, search, paging and storage; Session owns context snapshots. */
import type {
  MemoryCapability,
  MemoryCapabilityBuilder,
  MemoryCapabilitySubject,
} from '../../../source/services/memory/memory-capabilities.js';
import type {
  AutomaticMemoryCanary,
  AutomaticMemoryReceipt,
} from '../../../source/services/memory/automatic-memory-canary.js';
import { personalMemoryNotice } from '../../../source/services/conversation/personal-memory-context.js';
import type { Item, ItemId } from '../model/index.js';
import type { Tool } from '../tools/index.js';

export type DirectMemoryFact =
  | { readonly type: 'memory_global_snapshot'; readonly snapshot: string }
  | { readonly type: 'memory_personal_snapshot'; readonly admissionId: string; readonly snapshot: string }
  | { readonly type: 'automatic_memory_started'; readonly admissionId: string }
  | {
      readonly type: 'automatic_memory_finished';
      readonly admissionId: string;
      readonly receipt?: AutomaticMemoryReceipt;
    }
  | { readonly type: 'automatic_memory_disabled'; readonly admissionId: string; readonly reason: string };
export type DirectMemoryState = {
  readonly globalSnapshot?: string;
  readonly personalSnapshot?: string;
  readonly automaticPending?: string;
  readonly automaticRecorded: boolean;
  readonly automaticStopped: boolean;
};
export type DirectMemoryCapability = {
  readonly access: MemoryCapability['access'];
  readonly tools: readonly Tool[];
  readonly guidance: string;
  readonly globalContext: string;
  readonly resolvePersonalContext?: () => string;
  /** Must be accepted before using the instructions/provider input. */
  readonly facts: readonly DirectMemoryFact[];
};

/** Pure accepted-fact projection, also retaining snapshot comparison across compaction. */
export function reduceDirectMemory(state: DirectMemoryState, fact: DirectMemoryFact): DirectMemoryState {
  switch (fact.type) {
    case 'memory_global_snapshot':
      if (state.globalSnapshot !== undefined) throw new Error('Global memory context is already snapshotted');
      return { ...state, globalSnapshot: fact.snapshot };
    case 'memory_personal_snapshot':
      return { ...state, personalSnapshot: fact.snapshot };
    case 'automatic_memory_started':
      if (state.automaticPending || state.automaticStopped || state.automaticRecorded)
        throw new Error('Automatic memory is unavailable');
      return { ...state, automaticPending: fact.admissionId };
    case 'automatic_memory_finished':
      if (state.automaticPending !== fact.admissionId) throw new Error('Unknown automatic memory admission');
      return {
        ...state,
        automaticPending: undefined,
        automaticRecorded: state.automaticRecorded || Boolean(fact.receipt),
      };
    case 'automatic_memory_disabled':
      if (state.automaticPending !== fact.admissionId) throw new Error('Unknown automatic memory admission');
      return { ...state, automaticPending: undefined, automaticStopped: true };
  }
}

/**
 * Build with the clean existing MemoryCapabilityBuilder (main/librarian write,
 * explorer/worker read, other roles none). App supplies its normal direct tool
 * adapter; this module never invokes scripted definitions outside engine gates.
 * The global index is frozen once per Session; project summaries stay fresh at
 * real human admission. Replay supplies state, never rereads today's store.
 */
export function createDirectMemoryCapability(deps: {
  readonly builder: Pick<MemoryCapabilityBuilder, 'build'>;
  readonly adaptTool: (definition: MemoryCapability['tools'][number]) => Tool;
  readonly subject: MemoryCapabilitySubject;
  readonly projectPath: string;
  readonly state: DirectMemoryState;
  readonly includeContext?: boolean;
  readonly personalContextOptIn?: boolean;
}): DirectMemoryCapability {
  const facts: DirectMemoryFact[] = [];
  const capability = deps.builder.build(deps.subject, {
    projectPath: deps.projectPath,
    includeContext: deps.includeContext,
    personalContextOptIn: deps.personalContextOptIn,
    snapshotGlobalContext(read) {
      if (deps.state.globalSnapshot !== undefined) return deps.state.globalSnapshot;
      const snapshot = read();
      facts.push({ type: 'memory_global_snapshot', snapshot });
      return snapshot;
    },
  });
  return {
    access: capability.access,
    tools: capability.tools.map(deps.adaptTool),
    guidance: capability.guidance,
    globalContext: capability.context,
    resolvePersonalContext: capability.resolvePersonalContext,
    facts,
  };
}

/** Persist this fact alongside the raw human admission; render only into model input. */
export function planDirectPersonalMemory(
  state: DirectMemoryState,
  capability: Pick<DirectMemoryCapability, 'resolvePersonalContext'>,
  admissionId: string,
): Extract<DirectMemoryFact, { type: 'memory_personal_snapshot' }> | undefined {
  // An absent resolver also withdraws a previously supplied snapshot after memory is disabled.
  const snapshot = capability.resolvePersonalContext?.() ?? '';
  return snapshot === (state.personalSnapshot ?? '')
    ? undefined
    : { type: 'memory_personal_snapshot', admissionId, snapshot };
}

/** Deterministic replay materialization; never modifies the human's original Item. */
export function directPersonalMemoryItem(fact: Extract<DirectMemoryFact, { type: 'memory_personal_snapshot' }>): Item {
  return {
    type: 'user_message',
    id: `personal-memory:${fact.admissionId}` as ItemId,
    content: [{ type: 'text', text: personalMemoryNotice(fact.snapshot) }],
  };
}

export type DirectAutomaticMemoryNotice = {
  readonly success: boolean;
  readonly command: string;
  readonly output: string;
  readonly receipt?: AutomaticMemoryReceipt;
};

/**
 * Optional, explicitly enabled canary, using the existing narrow preference-only
 * writer. Start intent is accepted before the store call; a lost receipt is an
 * unknown outcome, never retried blindly or reported as a successful write.
 */
export function createDirectAutomaticMemory(deps: {
  readonly sessionId: string;
  readonly canary: Pick<AutomaticMemoryCanary, 'record'>;
  readonly allowed: () => boolean;
  readonly readState: () => DirectMemoryState;
  readonly commit: (facts: readonly DirectMemoryFact[]) => boolean | Promise<boolean>;
}): (input: {
  readonly admissionId: string;
  readonly text: string;
  readonly images?: readonly unknown[];
  readonly skill?: unknown;
}) => Promise<DirectAutomaticMemoryNotice | undefined> {
  return async (input) => {
    const state = deps.readState();
    if (
      !deps.allowed() ||
      state.automaticRecorded ||
      state.automaticStopped ||
      state.automaticPending ||
      input.images?.length ||
      input.skill
    )
      return;
    if (!(await deps.commit([{ type: 'automatic_memory_started', admissionId: input.admissionId }]))) return;
    let receipt: AutomaticMemoryReceipt | null;
    try {
      receipt = await deps.canary.record(input.text, deps.sessionId);
    } catch {
      const reason = 'Automatic memory stopped after a storage error. Review the memory index before retrying.';
      if (!(await deps.commit([{ type: 'automatic_memory_disabled', admissionId: input.admissionId, reason }]))) {
        throw new Error('Automatic memory failed and its disabled state could not be persisted');
      }
      return { success: false, command: 'Automatic memory canary disabled', output: reason };
    }
    if (
      !(await deps.commit([
        { type: 'automatic_memory_finished', admissionId: input.admissionId, ...(receipt ? { receipt } : {}) },
      ]))
    ) {
      throw new Error('Automatic memory outcome could not be persisted; inspect the memory store before retrying');
    }
    if (!receipt) return;
    return {
      success: true,
      command: 'Automatic memory canary',
      receipt,
      output: `Learned (project): ${receipt.quote}\nSource session: ${receipt.sourceSessionId}\nReview with memory_get({scope:"project",id:"${receipt.id}"}); undo with ${receipt.undo}`,
    };
  };
}
