/** Durable selection intent and the app-prepared runtime generation accepted by Session. */
import { z } from 'zod';
import type { ModelRef, ReasoningEffort } from '../model/index.js';
import type { DirectContextCapabilities } from './direct-capabilities.js';
import type { DirectCommandConfiguration } from './direct-command-types.js';
import type { ConversationDeps, TurnRequest } from './direct-types.js';
import type { Fact, SessionStartedFact } from './facts.js';

export type DirectConfigurationState = {
  readonly configuration: DirectCommandConfiguration & { readonly model: ModelRef };
  readonly intent: {
    readonly modelSelection: ModelRef;
    readonly reasoningEffort: 'default' | ReasoningEffort;
    readonly temperature?: number;
  };
  readonly profile: SessionStartedFact['profile'];
};
export type DirectConfigurationFact = DirectConfigurationState & { readonly type: 'configuration_changed' };
export type DirectPreparedConfiguration = DirectConfigurationState & {
  readonly deps: Omit<ConversationDeps, 'log' | 'context' | 'publishTask' | 'publishBranch' | 'publishNotice'>;
  readonly request: Omit<TurnRequest, 'input' | 'model' | 'submission'>;
  readonly capabilities: DirectContextCapabilities;
  /** Synchronous NO-THROW app record-pointer swap only; no observers or user callbacks. */
  install(): void;
  /** Discard only before installation; install transfers shutdown ownership to app. */
  dispose(): void | Promise<void>;
};

const id = z.string().min(1);
const model = z.object({ provider: id, model: id }).strict();
const reasoning = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const directConfigurationFactSchema = z
  .object({
    type: z.literal('configuration_changed'),
    configuration: z
      .object({ model, reasoning: reasoning.optional(), temperature: z.number().finite().optional() })
      .strict(),
    intent: z
      .object({
        modelSelection: model,
        reasoningEffort: z.union([z.literal('default'), reasoning]),
        temperature: z.number().finite().optional(),
      })
      .strict(),
    profile: z.object({ id, version: z.string(), digest: z.string() }).strict(),
  })
  .strict();

/** Validate only durable selection data; runtime objects and credentials never enter the log. */
export function parseDirectConfigurationFact(raw: unknown): DirectConfigurationFact {
  const value = directConfigurationFactSchema.parse(raw);
  if (
    value.configuration.model.provider !== value.intent.modelSelection.provider ||
    value.configuration.model.model !== value.intent.modelSelection.model
  )
    throw new Error('Configured effective model and restoration intent disagree');
  return raw as DirectConfigurationFact;
}

/** Reopen restores the latest accepted selection, never a pending preparation or command patch. */
export function latestDirectConfiguration(facts: readonly Fact[]): DirectConfigurationState | undefined {
  for (let index = facts.length - 1; index >= 0; --index) {
    const fact = facts[index]!;
    if (fact.type === 'configuration_changed') {
      const { type: _type, ...state } = parseDirectConfigurationFact(fact);
      return structuredClone(state);
    }
  }
  return undefined;
}
