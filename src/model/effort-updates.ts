/**
 * Cache-preserving reasoning-effort changes.
 *
 * Changing the top-level effort between requests invalidates the provider's
 * prompt cache (measured 2026-11-14 on Claude Haiku 5.5, GPT-6 Luna and
 * GPT-6.1 Terra; see docs/research/model-effort-step-down-cache-economics.md).
 * Models that accept an in-conversation effort item keep the cached prefix
 * when the change travels as input instead. Session expresses a change as an
 * `effort_update` marker in history and keeps the request's top-level effort at
 * the value the conversation started with; each supported adapter renders the
 * marker natively and every other path gets the effective effort back as the
 * top-level value with the marker removed (`withoutEffortUpdates`).
 */
import type { Item, Model, ReasoningEffort } from './index.js';
import type { StreamedModelTurnInput } from './streamed-model-turn.js';

export const EFFORT_UPDATE = 'effort_update';

/** Levels every wired mechanism accepts. `none`/`minimal` stay on today's top-level path. */
export const CACHE_SAFE_EFFORT_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * OpenAI models that take a `configuration_update` input item on the Responses
 * API. The family is "GPT-6 and later"; these are the GPT-6 ids in the model
 * catalogue (`model-catalog/catalog.generated.ts`, openai and codex). GPT-6 Luna
 * and GPT-6.1 Terra were measured; the others are listed from the family rule.
 * GPT-5.6 and earlier break the cache on any effort change and are not listed.
 */
const CONFIGURATION_UPDATE_MODELS: ReadonlySet<string> = new Set([
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
]);

export function supportsConfigurationUpdate(model: string): boolean {
  return CONFIGURATION_UPDATE_MODELS.has(model);
}

/**
 * Claude models whose per-message effort (beta `mid-conversation-output-config-2026-07-01`)
 * term2 can use: the docs list Fable 5.1/5.2, Mythos 5.1/5.2, Opus 5/5.5, Sonnet 5.5 and
 * Haiku 5.5, thinking on (adaptive) only. Term2 sends adaptive thinking only to Haiku and
 * Sonnet 5.5 (`ai-sdk-anthropic.provider.ts`); the others get a token budget, which the
 * per-message form does not accept. Extend both lists together.
 */
export function supportsPerMessageEffort(model: string): boolean {
  return /^claude-(?:haiku|sonnet)-5-5(?:-|$)/.test(model);
}

/** Model property set by the provider registry for models that can take markers. */
export type EffortUpdateModel = Model & { readonly effortUpdates?: readonly ReasoningEffort[] };

export function effortUpdateLevels(model: Model): readonly ReasoningEffort[] | undefined {
  const levels = (model as EffortUpdateModel).effortUpdates;
  return Array.isArray(levels) && levels.length ? levels : undefined;
}

export function effortUpdateItem(id: string, provider: string, effort: ReasoningEffort): Item {
  return { type: 'provider_input', id: id as Item['id'], provider, input: { type: EFFORT_UPDATE, effort } };
}

export function isEffortUpdateItem(item: Item): item is Extract<Item, { type: 'provider_input' }> {
  return item.type === 'provider_input' && item.input.type === EFFORT_UPDATE;
}

export type EffortUpdateInput = Extract<StreamedModelTurnInput, { type: 'effort_update' }>;

/** The effort the last marker sets, if any. */
export function lastEffortUpdate(items: readonly Item[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (isEffortUpdateItem(item) && typeof item.input.effort === 'string') return item.input.effort;
  }
  return undefined;
}

/** Today's request for a path without a mechanism: markers removed, the effective effort top-level. */
export function withoutEffortUpdates(
  input: readonly Item[],
  reasoning: ReasoningEffort | undefined,
  carried?: string,
): { readonly input: readonly Item[]; readonly reasoning: ReasoningEffort | undefined } {
  const effective = (lastEffortUpdate(input) ?? carried ?? reasoning) as ReasoningEffort | undefined;
  return { input: input.filter((item) => !isEffortUpdateItem(item)), reasoning: effective };
}
