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
 *
 * Off by default (`agent.cachePreservingEffort`): none of the direct endpoints
 * (OpenAI, Codex, Anthropic first-party) has been probed on real traffic; the
 * mechanisms were measured through OpenRouter only. An endpoint that rejects a
 * marker turns the mechanism off for the rest of the session (`effort-fallback.ts`).
 */
import type { Item, Model, ModelRequest, ReasoningEffort } from './index.js';
import type { ResponseContinuation } from './providers/runtime/model-events.js';
import type { StreamedModelTurnInput } from './streamed-model-turn.js';

const EFFORT_UPDATE = 'effort_update';

/** Levels every wired mechanism accepts. `none`/`minimal` stay on today's top-level path. */
export const CACHE_SAFE_EFFORT_LEVELS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * OpenAI models that take a `configuration_update` input item on the Responses
 * API: the GPT-6 ids in the direct model catalogue (`catalog.generated.ts`,
 * openai and codex). Only gpt-6-luna was measured (through OpenRouter on Azure);
 * gpt-6.1-terra was also measured there but is not in the direct catalogue.
 * astra, sol and 6.1-sol are enabled from the documented "GPT-6 and later" rule
 * only. GPT-5.6 and earlier break the cache on any effort change.
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
 * term2 can use. Only claude-haiku-5-5 was measured (OpenRouter /messages, Anthropic
 * upstream); claude-sonnet-5-5 is enabled from the docs. The docs list the docs list Fable 5.1/5.2, Mythos 5.1/5.2, Opus 5/5.5, Sonnet 5.5 and
 * Haiku 5.5, thinking on (adaptive) only. Term2 sends adaptive thinking only to Haiku and
 * Sonnet 5.5 (`ai-sdk-anthropic.provider.ts`); the others get a token budget, which the
 * per-message form does not accept. Extend both lists together.
 */
export function supportsPerMessageEffort(model: string): boolean {
  return /^claude-(?:haiku|sonnet)-5-5(?:-|$)/.test(model);
}

/** `agent.cachePreservingEffort`: which endpoints may receive markers. */
export type EffortUpdateScope = 'first-party' | 'any-endpoint';

export function effortUpdateScope(value: unknown): EffortUpdateScope | undefined {
  return value === 'first-party' || value === 'any-endpoint' ? value : undefined;
}

/** The provider's own host (an unset base URL means its default), or any endpoint when the scope allows. */
export function endpointInScope(
  baseUrl: string | undefined,
  firstPartyHost: string,
  scope: EffortUpdateScope,
): boolean {
  if (scope === 'any-endpoint' || !baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === firstPartyHost;
  } catch {
    return false;
  }
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
function withoutEffortUpdates(
  input: readonly Item[],
  reasoning: ReasoningEffort | undefined,
  carried?: string,
): { readonly input: readonly Item[]; readonly reasoning: ReasoningEffort | undefined } {
  const effective = (lastEffortUpdate(input) ?? carried ?? reasoning) as ReasoningEffort | undefined;
  return { input: input.filter((item) => !isEffortUpdateItem(item)), reasoning: effective };
}

/**
 * `effort_update` markers reach only a model that declares the marker's level; any other
 * path gets today's request back: no marker, the effective effort as the top-level value.
 * A request without markers or a carried effort passes through unchanged.
 */
export function resolveEffortUpdates(
  request: ModelRequest,
  levels: readonly string[] | undefined,
): { input: ModelRequest['input']; reasoning: ModelRequest['reasoning']; conversationEffort?: string } {
  const carried = (request.continuation as Partial<ResponseContinuation> | undefined)?.effort;
  const markers = request.input.filter(isEffortUpdateItem);
  if (!markers.length && carried === undefined) return { input: request.input, reasoning: request.reasoning };
  const supported =
    !!levels &&
    !!request.reasoning &&
    levels.includes(request.reasoning) &&
    (carried === undefined || levels.includes(carried)) &&
    markers.every((item) => typeof item.input.effort === 'string' && levels.includes(item.input.effort));
  if (!supported) return withoutEffortUpdates(request.input, request.reasoning, carried);
  const effective = lastEffortUpdate(request.input) ?? carried ?? request.reasoning;
  return {
    input: request.input,
    reasoning: request.reasoning,
    ...(effective && effective !== request.reasoning ? { conversationEffort: effective } : {}),
  };
}
