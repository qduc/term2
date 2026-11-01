/** Accepted configuration generations: validate before durable acceptance, then install once. */
import { DirectContinuity, type DirectContinuityBinding } from '../engine/direct-recovery-continuity.js';
import type { ConversationDeps, TurnRequest } from './direct-types.js';
import { parseDirectConfigurationFact, type DirectPreparedConfiguration } from './direct-configuration.js';

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
