import { withNotice } from './input-notice.js';
import type { PreparedDirectRequest } from '../engine/recovery-continuity.js';
import type { ModelRequest } from '../model/index.js';
import type { bindDirectCapabilities } from './capabilities.js';
import { directPreviewConfiguration, directPreviewOccurrences } from './preview.js';
import type { Conversation } from './types.js';
import type { Fact } from './facts.js';
import { replay } from './replay.js';
/** Accepted configuration generations: validate before durable acceptance, then install once. */
import { DirectContinuity, type DirectContinuityBinding } from '../engine/recovery-continuity.js';
import { parseDirectConfigurationFact, type DirectPreparedConfiguration } from './configuration.js';
import type { ConversationDeps, TurnRequest } from './types.js';

export type PreparedConversationGeneration = {
  readonly configurationFact: ReturnType<typeof parseDirectConfigurationFact>;
  readonly nextRequest: Omit<TurnRequest, 'input' | 'submission'>;
  readonly nextDeps: ConversationDeps;
  readonly nextContinuity: { readonly binding: DirectContinuityBinding; readonly state: DirectContinuity } | undefined;
};

/** Reject attempts to replace Session-owned hooks, memory lifetime, or workspace authority. */
export function prepareConversationGeneration(
  deps: ConversationDeps,
  runtimeDeps: ConversationDeps,
  supplied: DirectPreparedConfiguration['capabilities'] | undefined,
  candidate: DirectPreparedConfiguration,
): PreparedConversationGeneration {
  if (
    candidate.capabilities.hooks !== supplied?.hooks ||
    candidate.capabilities.automaticMemory !== supplied?.automaticMemory ||
    candidate.capabilities.memory?.globalContext !== supplied?.memory?.globalContext ||
    candidate.capabilities.memory?.facts !== supplied?.memory?.facts
  )
    throw new Error('Configure attempted to replace the Session hooks or memory lifetime');
  const expectedWorkspace = deps.toolContext?.workspace;
  const nextWorkspace = candidate.deps.toolContext?.workspace;
  if (
    expectedWorkspace &&
    (!nextWorkspace ||
      nextWorkspace.root !== expectedWorkspace.root ||
      nextWorkspace.target !== expectedWorkspace.target ||
      nextWorkspace.access !== expectedWorkspace.access)
  )
    throw new Error('Configure cannot change Session workspace authority');
  if (
    candidate.profileTransitionNotice !== undefined &&
    (typeof candidate.profileTransitionNotice !== 'string' || !candidate.profileTransitionNotice.trim())
  )
    throw new Error('Profile transition notice must be nonempty text');
  const configurationFact = parseDirectConfigurationFact({
    type: 'configuration_changed',
    configuration: candidate.configuration,
    intent: candidate.intent,
    profile: candidate.profile,
  });
  const nextRequest = { ...candidate.request, model: candidate.configuration.model };
  const nextDeps: ConversationDeps = {
    ...candidate.deps,
    log: deps.log,
    context: deps.context,
    rotationBoundary: deps.rotationBoundary,
    configure: candidate.deps.configure ?? runtimeDeps.configure,
    rollover: candidate.deps.rollover ?? runtimeDeps.rollover,
    publishTask: deps.publishTask,
    publishBranch: deps.publishBranch,
    publishNotice: deps.publishNotice,
  };
  return {
    configurationFact,
    nextRequest,
    nextDeps,
    nextContinuity: nextDeps.continuity
      ? { ...nextDeps.continuity, state: nextDeps.continuity.state ?? new DirectContinuity() }
      : undefined,
  };
}

/** Installation follows durable acceptance; a throwing app install poisons its Session. */
export function installConversationGeneration(
  candidate: DirectPreparedConfiguration,
  prepared: PreparedConversationGeneration,
  previousContinuity: ConversationDeps['continuity'],
  replace: (tools: ConversationDeps['tools'], capabilities: DirectPreparedConfiguration['capabilities']) => void,
  install: (generation: PreparedConversationGeneration) => void,
  appendProfileNotice: (notice: string | undefined) => void,
): void {
  previousContinuity?.state?.clear();
  install(prepared);
  replace(candidate.deps.tools, candidate.capabilities);
  candidate.install();
  appendProfileNotice(candidate.profileTransitionNotice);
}

/** Owns the live configuration generation, continuity, and one-shot profile notice. */
export class ConversationGeneration {
  runtime: ConversationDeps;
  supplied: DirectPreparedConfiguration['capabilities'] | undefined;
  continuity: ConversationDeps['continuity'];
  request: Omit<TurnRequest, 'input' | 'submission'> | undefined;
  private profileNotice: string | undefined;
  constructor(private readonly deps: ConversationDeps) {
    this.runtime = deps;
    this.continuity = deps.continuity
      ? { ...deps.continuity, state: deps.continuity.state ?? new DirectContinuity() }
      : undefined;
  }
  currentRequest(fallback: Omit<TurnRequest, 'input' | 'submission'>): Omit<TurnRequest, 'input' | 'submission'> {
    if (!this.request) {
      const { notice, ...request } = fallback;
      this.request = request;
      if (notice) this.profileNotice = [this.profileNotice, notice].filter(Boolean).join('\n\n');
    }
    return this.request;
  }
  prepare(candidate: DirectPreparedConfiguration): PreparedConversationGeneration {
    return prepareConversationGeneration(this.deps, this.runtime, this.supplied, candidate);
  }
  /** Called only after commit. Installation failure is handled by the journal owner. */
  install(
    candidate: DirectPreparedConfiguration,
    prepared: PreparedConversationGeneration,
    replace: Parameters<typeof installConversationGeneration>[3],
    installed: (request: PreparedConversationGeneration['nextRequest']) => void,
  ): void {
    installConversationGeneration(
      candidate,
      prepared,
      this.continuity,
      replace,
      (generation) => {
        this.runtime = generation.nextDeps;
        this.continuity = generation.nextContinuity;
        this.request = generation.nextRequest;
        this.supplied = candidate.capabilities;
        installed(generation.nextRequest);
      },
      (notice) => {
        if (notice) this.profileNotice = [this.profileNotice, notice].filter(Boolean).join('\n\n');
      },
    );
  }
  notice(requestNotice: string | undefined, consume = false, includeProfile = true): string | undefined {
    const notice =
      [includeProfile ? this.profileNotice : undefined, requestNotice].filter(Boolean).join('\n\n') || undefined;
    if (consume) this.profileNotice = undefined;
    return notice;
  }
  /** A read-only preview never consumes notices, memory or continuity tickets. */
  preview(
    request: TurnRequest,
    facts: readonly Fact[],
    capabilities: ReturnType<typeof bindDirectCapabilities>,
    queueActive: boolean,
    openedAt?: number,
  ): ReturnType<Conversation['snapshotInputPreview']> {
    const configuration = directPreviewConfiguration(request);
    if (!configuration) throw new Error('App has not supplied the effective previewMode');
    // Preview the accepted live cut, including in-flight Items/deltas, without
    // synthesizing crash-time tool results, wait closures or root terminals.
    // An unfinished projection's interrupted status is not a live failure.
    const history = replay(facts, { recoverQueue: false, recoverActiveTurn: false, openedAt }).history;
    // This is the same pure admission plan, but its returned context facts are
    // deliberately NOT accepted. No memory/notice/goal state is consumed.
    const human = capabilities.humanPlan('preview', request.input);
    const notice = this.notice(request.notice);
    const modelInput = notice ? withNotice(human.modelInput, notice) : human.modelInput;
    const canonical: ModelRequest = {
      model: request.model,
      instructions: request.instructions,
      input: [...history, ...modelInput],
      tools: request.tools,
      ...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.providerOptions !== undefined ? { providerOptions: request.providerOptions } : {}),
    };
    const prepared = capabilities.previewRequest(canonical);
    let selected: Omit<PreparedDirectRequest, 'ticket'> = { request: prepared, chained: false };
    if (this.continuity) {
      // Engine owns this read-only selector. Never call prepare here: even an
      // unchainable preview must not clear a checkpoint or increment a ticket.
      selected = this.continuity.state!.preview(prepared, this.continuity.binding, true);
    }
    return structuredClone({
      input: selected.request.input,
      kind: selected.chained ? 'delta' : 'full_history',
      configuration,
      queueActive,
      toolOccurrences: directPreviewOccurrences(facts, selected.request.input),
    });
  }
}
