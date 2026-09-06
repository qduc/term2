import { createInterface } from 'node:readline';
import { getProvider, getProviderIds } from '../../providers/index.js';
import {
  getModelCacheFilePath,
  matchTier,
  peekCachedModels,
  rankModelMatch,
  type ModelInfo,
} from '../model-service.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { scoreSubsequence } from '../../utils/subsequence-filter.js';
import { collectProviderModelsConcurrently, loadProviderModelGroup, type ProviderModelGroup } from './model-listing.js';
import { orderedProviderIds, type ModelFetcher } from './model-catalog-session.js';
import { HARNESS_IDLE_ENV } from '../../lib/harness-input-idle.js';
import { getFavoriteModelInfos } from './model-favorites.js';
import { findNicknameMatch } from './model-nicknames.js';
import { stripReasoningEffortSuffix, type ModelSettingsReasoningEffort } from './reasoning-effort.js';

// Re-exported for the existing importers of this module; the definitions live
// in reasoning-effort.ts so model-nicknames can share them without a cycle.
export { VALID_REASONING_EFFORTS, type ModelSettingsReasoningEffort } from './reasoning-effort.js';

export type ParsedModelFlag = {
  provider?: string;
  pattern: string;
  reasoningEffort?: ModelSettingsReasoningEffort;
  rawPattern: string;
};

export type ModelMatch = {
  provider: string;
  model: ModelInfo;
};

export type InteractivePickerSelection = { modelId: string; provider: string };

export type InteractivePickerRequest = {
  /** Filter query the picker opens with (the stripped, provider/suffix-free pattern). */
  initialQuery: string;
  /**
   * Provider tab the picker should open on: the provider of the top-ranked
   * match, so the seeded query actually matches in the catalog the picker
   * is prioritized in the unified catalog.
   */
  initialProvider?: string;
  /** Set when --provider (or a parsed provider prefix) narrows permanently; locks the tab. */
  lockProvider?: string;
  /** One-line explanations shown above the menu (e.g. why nothing matched). */
  bannerLines?: string[];
};

/**
 * Opens the interactive model picker and resolves to the chosen model, or
 * `null` on cancellation. Callers wire this to `runModelPickerHost`
 * (source/services/models/model-picker-host.tsx); tests can supply a stub.
 * When supplied, it REPLACES the readline-based `promptForDisambiguation`
 * fallback for ambiguous matches, and replaces the hard `no_match` error with
 * an interactive re-search seeded with the same query. It must only ever be
 * supplied by a caller that has already confirmed an interactive session
 * (real TTY, no positional prompt, no --json, no isolated-harness marker) —
 * this module does not re-derive that eligibility itself.
 */
export type InteractivePicker = (request: InteractivePickerRequest) => Promise<InteractivePickerSelection | null>;

export type ModelResolutionResult =
  | {
      status: 'resolved';
      modelId: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort;
      /** Provider catalogs that failed to load while resolution still proceeded. */
      warnings?: string[];
    }
  | {
      status: 'no_match';
      error: string;
    }
  | {
      status: 'cancelled';
      error: string;
    }
  | {
      status: 'passthrough';
      modelId: string;
      provider?: string;
      reasoningEffort?: ModelSettingsReasoningEffort;
      /** Provider catalogs that failed to load while resolution still proceeded. */
      warnings?: string[];
    };

/**
 * Parse a raw `--model` flag string, separating optional thinking suffix
 * (":<thinking>") and optional provider prefix ("<provider>/<id>").
 */
export function parseModelFlag(
  rawModelFlag: string,
  options?: { providerFlag?: string; knownProviders?: string[] },
): ParsedModelFlag {
  const trimmed = rawModelFlag.trim();

  // 1. Extract thinking suffix (e.g. :high, :low, :medium)
  const { value: withoutThinking, reasoningEffort } = stripReasoningEffortSuffix(trimmed);
  const rawPattern = withoutThinking;

  // 2. Extract provider prefix
  if (options?.providerFlag) {
    return {
      provider: options.providerFlag,
      pattern: withoutThinking,
      reasoningEffort,
      rawPattern,
    };
  }

  const slashIdx = withoutThinking.indexOf('/');
  if (slashIdx !== -1) {
    const prefix = withoutThinking.slice(0, slashIdx).toLowerCase();
    const known = options?.knownProviders ?? getProviderIds();
    if (known.map((k) => k.toLowerCase()).includes(prefix)) {
      return {
        provider: prefix,
        pattern: withoutThinking.slice(slashIdx + 1).trim(),
        reasoningEffort,
        rawPattern,
      };
    }
  }

  return {
    provider: undefined,
    pattern: withoutThinking,
    reasoningEffort,
    rawPattern,
  };
}

/**
 * Match parsed model pattern against loaded provider model groups.
 * Exact matches take strict precedence over partial/fuzzy matches, and an
 * exact match of the flag exactly as typed (including any provider-style
 * prefix) takes precedence over the split provider+pattern reading, so a
 * literal aggregator id like `anthropic/claude-3.5-sonnet` is never
 * reinterpreted when the vendor name collides with a provider id.
 */
export function matchModels(
  groups: ProviderModelGroup[],
  parsed: ParsedModelFlag,
): { exact: boolean; matches: ModelMatch[] } {
  const patternLower = parsed.pattern.toLowerCase();
  const rawPatternLower = parsed.rawPattern.toLowerCase();

  // Stage 0: The id exactly as typed. When the raw flag (prefix included) is a
  // real model id somewhere, use it verbatim instead of the split reading.
  const asTypedMatches: ModelMatch[] = [];
  for (const group of groups) {
    for (const model of group.models) {
      if (model.id.toLowerCase() === rawPatternLower) {
        asTypedMatches.push({ provider: group.provider, model });
      }
    }
  }
  if (asTypedMatches.length > 0) {
    return { exact: true, matches: asTypedMatches };
  }

  // Stage 1: Exact matches on the stripped pattern
  const exactMatches: ModelMatch[] = [];
  for (const group of groups) {
    if (parsed.provider && group.provider.toLowerCase() !== parsed.provider.toLowerCase()) {
      // Check if rawPattern matches a slash model id in another provider (e.g. openrouter)
      for (const model of group.models) {
        if (model.id.toLowerCase() === rawPatternLower) {
          exactMatches.push({ provider: group.provider, model });
        }
      }
      continue;
    }

    for (const model of group.models) {
      if (model.id.toLowerCase() === patternLower || model.id.toLowerCase() === rawPatternLower) {
        exactMatches.push({ provider: group.provider, model });
      }
    }
  }

  if (exactMatches.length > 0) {
    return { exact: true, matches: exactMatches };
  }

  // Stage 2: Fuzzy / partial matches, ranked deterministically (tier, then
  // score, then provider order) instead of raw provider-iteration order.
  // `groups` is expected in provider-priority order (orderedProviderIds), so
  // its index doubles as the provider-order tiebreak without a third param.
  type RankedFuzzyMatch = { match: ModelMatch; tier: number; score: number; groupIndex: number };
  const ranked: RankedFuzzyMatch[] = [];
  const trimmed = parsed.pattern.trim();

  groups.forEach((group, groupIndex) => {
    if (parsed.provider) {
      if (group.provider.toLowerCase() !== parsed.provider.toLowerCase()) {
        return;
      }
      for (const model of group.models) {
        const rank = rankModelMatch(model, trimmed);
        if (rank) {
          ranked.push({ match: { provider: group.provider, model }, tier: rank.tier, score: rank.score, groupIndex });
        }
      }
      return;
    }

    // No provider specified: a provider-name match pulls in the whole group,
    // ranked by how well the provider name itself matched.
    const providerScore = scoreSubsequence(trimmed, group.provider);
    if (providerScore !== -Infinity) {
      const tier = matchTier(trimmed, group.provider);
      for (const model of group.models) {
        ranked.push({ match: { provider: group.provider, model }, tier, score: providerScore, groupIndex });
      }
      return;
    }

    for (const model of group.models) {
      const rank = rankModelMatch(model, trimmed);
      if (rank) {
        ranked.push({ match: { provider: group.provider, model }, tier: rank.tier, score: rank.score, groupIndex });
      }
    }
  });

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.score !== b.score) return b.score - a.score;
    return a.groupIndex - b.groupIndex;
  });

  return { exact: false, matches: ranked.map((r) => r.match) };
}

/**
 * Format matching models as a numbered list grouped by provider,
 * matching `--list-models` style with sequential 1-based numbering.
 */
export function formatDisambiguationPrompt(matches: ModelMatch[], groups: ProviderModelGroup[]): string {
  const lines: string[] = [];
  const labelByProvider = new Map<string, string>();
  for (const group of groups) {
    const label = group.label ?? getProvider(group.provider)?.label;
    if (label && label !== group.provider) {
      labelByProvider.set(group.provider, label);
    }
  }

  const byProvider = new Map<string, ModelMatch[]>();
  for (const match of matches) {
    const list = byProvider.get(match.provider) ?? [];
    list.push(match);
    byProvider.set(match.provider, list);
  }

  let index = 1;
  for (const [provider, list] of byProvider) {
    const label = labelByProvider.get(provider);
    const header = label ? `${provider} (${label}):` : `${provider}:`;
    lines.push(header);
    for (const match of list) {
      const model = match.model;
      const name = model.name && model.name !== model.id ? `  ${model.name}` : '';
      lines.push(`  ${index}) ${model.id}${name}`);
      index++;
    }
  }

  return lines.join('\n');
}

/**
 * Interactive prompt for disambiguating multiple matching models.
 */
export async function promptForDisambiguation(
  matches: ModelMatch[],
  groups: ProviderModelGroup[],
  pattern: string,
  prompter?: (question: string) => Promise<string | null>,
  streams?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream },
): Promise<ModelMatch | null> {
  const formatted = formatDisambiguationPrompt(matches, groups);
  const promptText = `Multiple models match "${pattern}":\n\n${formatted}\n\nSelect a model [1-${matches.length}]: `;

  if (prompter) {
    const answer = await prompter(promptText);
    if (!answer) return null;
    const num = parseInt(answer.trim(), 10);
    if (!Number.isNaN(num) && num >= 1 && num <= matches.length) {
      return matches[num - 1];
    }
    return null;
  }

  const input = streams?.input ?? process.stdin;
  // Prompts go to stderr by default: stdout carries structured output (--json
  // NDJSON, pipes) and must stay machine-readable.
  const output = streams?.output ?? process.stderr;
  const rl = createInterface({ input, output });
  try {
    output.write(`Multiple models match "${pattern}":\n\n${formatted}\n\n`);
    while (true) {
      const answer = await new Promise<string | null>((resolve) => {
        rl.question(`Select a model [1-${matches.length}]: `, (res) => resolve(res));
        rl.once('close', () => resolve(null));
      });

      if (answer === null) return null;
      const num = parseInt(answer.trim(), 10);
      if (!Number.isNaN(num) && num >= 1 && num <= matches.length) {
        return matches[num - 1];
      }
      output.write(`Please enter a number between 1 and ${matches.length}.\n`);
    }
  } finally {
    rl.close();
  }
}

/** Groups flat ModelInfo rows by provider, preserving first-seen provider order. */
function groupModelInfosByProvider(models: ModelInfo[]): ProviderModelGroup[] {
  const order: string[] = [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of models) {
    if (!byProvider.has(model.provider)) {
      byProvider.set(model.provider, []);
      order.push(model.provider);
    }
    byProvider.get(model.provider)!.push(model);
  }
  return order.map((provider) => ({ provider, models: byProvider.get(provider)! }));
}

/**
 * Resolves `--model <pattern>` against the model catalog with exact match
 * precedence, partial/fuzzy matching, and interactive disambiguation when needed.
 */
export async function resolveModelFlag(deps: {
  modelFlag: string;
  providerFlag?: string;
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  fetcher?: ModelFetcher;
  prompter?: (question: string) => Promise<string | null>;
  streams?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream };
  knownProviders?: string[];
  providerIds?: string[];
  /** See `InteractivePicker`. Only ever set by a confirmed-interactive caller. */
  interactivePicker?: InteractivePicker;
}): Promise<ModelResolutionResult> {
  const knownProviders = deps.knownProviders ?? getProviderIds();
  const parsed = parseModelFlag(deps.modelFlag, {
    providerFlag: deps.providerFlag,
    knownProviders,
  });

  // Isolated black-box provider harnesses replay wire turns and do not mock catalog endpoints
  if (process.env[HARNESS_IDLE_ENV] && deps.prompter === undefined && deps.interactivePicker === undefined) {
    return {
      status: 'passthrough',
      modelId: parsed.rawPattern,
      provider: parsed.provider,
      reasoningEffort: parsed.reasoningEffort,
    };
  }

  // Explicit --provider is the user deliberately scoping the search (it also
  // sets agent.provider for the session), so it narrows PERMANENTLY: a miss
  // there errors out rather than silently resolving to a provider the user
  // didn't name. A provider-style prefix parsed out of the flag itself (e.g.
  // the `anthropic/` in `anthropic/claude-3.5-sonnet` on an aggregator) is a
  // different thing — it's just the best first guess, and the full id may
  // turn out to be a literal model id on some other provider, so a miss
  // there widens to the rest of the candidate space instead of giving up.
  const explicitProvider = Boolean(deps.providerFlag && parsed.provider);

  // Nicknames resolve first — before favorites and before any provider
  // catalog loads: reading `agent.modelNicknames` is a settings read, not a
  // fetch, so an exact hit costs zero network work. Precedence is exact
  // nickname > favorite > exact real model id: favorites already shadowed
  // exact real ids before nicknames existed (the favorites fast path below is
  // unchanged), so the nickname check slots in directly in front of it. A
  // real id shadowed by a nickname stays reachable as `provider/id`; a
  // nickname equal to a registered provider id is rejected at creation and
  // excluded at lookup, so `-m openai` can never be hijacked by a nickname.
  // A nickname whose target has vanished from a warm cache does not hard-fail:
  // like a vanished favorite, it falls through to the full search with a
  // warning instead of resolving to a model the provider will reject.
  const nicknameHit = findNicknameMatch(deps.settingsService, parsed.pattern, {
    providerScope: parsed.provider,
    knownProviders,
  });

  let nicknameVanishedWarning: string | undefined;

  if (nicknameHit) {
    const warmCache = peekCachedModels(nicknameHit.provider);
    const vanished = warmCache !== undefined && !warmCache.some((m) => m.id === nicknameHit.modelId);
    if (!vanished) {
      return {
        status: 'resolved',
        modelId: nicknameHit.modelId,
        provider: nicknameHit.provider,
        // An inline `-m op:low` suffix overrides the effort stored on the
        // nickname target (`op -> ...:high`).
        reasoningEffort: parsed.reasoningEffort ?? nicknameHit.reasoningEffort,
      };
    }
    nicknameVanishedWarning = `warning: nicknamed model "${nicknameHit.modelId}" is no longer in ${nicknameHit.provider}'s cached catalog; falling back to full search.`;
  }

  // Favorites resolve BEFORE any provider catalog loads: reading
  // `agent.favoriteModels` is a settings read, not a fetch, so a hit here
  // costs zero network work. Only favorites for the explicitly-scoped
  // provider are eligible when --provider narrows permanently, mirroring the
  // catalog path below; a slash-prefix guess (not --provider) doesn't narrow
  // the same way, since the full raw pattern might still be a literal id
  // favorited under a different provider.
  const allFavorites = getFavoriteModelInfos(deps.settingsService);
  const eligibleFavorites = explicitProvider
    ? allFavorites.filter((m) => m.provider.toLowerCase() === parsed.provider!.toLowerCase())
    : allFavorites;

  let favoriteVanishedWarning: string | undefined;

  if (eligibleFavorites.length > 0) {
    const favoriteGroups = groupModelInfosByProvider(eligibleFavorites);
    const favoriteMatch = matchModels(favoriteGroups, parsed);
    // Only an UNAMBIGUOUS favorite hit short-circuits; zero or multiple
    // matches fall through to the full catalog-backed search below (multiple
    // favorite matches get the normal, complete disambiguation prompt rather
    // than a guess restricted to favorites).
    if (favoriteMatch.matches.length === 1) {
      const hit = favoriteMatch.matches[0];
      // Read-only peek at whatever's already warm for that provider (memory
      // or non-expired disk cache) — never a fetch. If the cache is warm and
      // no longer lists this id, the favorite has gone stale (removed
      // upstream); fall back to the full search instead of resolving to a
      // model the provider will reject. A cold/absent cache can't disprove
      // the favorite, so it's trusted as-is — that's the latency win.
      const warmCache = peekCachedModels(hit.provider);
      const vanished = warmCache !== undefined && !warmCache.some((m) => m.id === hit.model.id);
      if (!vanished) {
        return {
          status: 'resolved',
          modelId: hit.model.id,
          provider: hit.provider,
          reasoningEffort: parsed.reasoningEffort,
        };
      }
      favoriteVanishedWarning = `warning: favorite model "${hit.model.id}" is no longer in ${hit.provider}'s cached catalog; falling back to full search.`;
    }
  }

  const loaderDeps = {
    settingsService: deps.settingsService,
    loggingService: deps.loggingService,
    fetcher: deps.fetcher,
  };

  // Full candidate space, in provider-priority order. `deps.providerIds`, when
  // supplied, replaces this entirely (tests use it to pin the universe of
  // providers without touching credential lookups).
  const fullOrder = deps.providerIds ?? orderedProviderIds(deps.settingsService, knownProviders);

  let order: string[];
  if (explicitProvider) {
    // Deliberately ignores `fullOrder`/`deps.providerIds` beyond this one id:
    // even a test-supplied candidate space listing other providers must not
    // leak into the load when the user explicitly scoped to one provider.
    order = [parsed.provider!];
  } else if (parsed.provider) {
    const rest = fullOrder.filter((id) => id.toLowerCase() !== parsed.provider!.toLowerCase());
    order = [parsed.provider, ...rest];
  } else {
    order = fullOrder;
  }

  // Walk lazily: load just the first (highest-priority) provider and stop
  // there if it already produced an exact match — `--model gpt-5.4` should
  // never touch a provider's catalog it didn't need. Only when that first
  // load comes up empty of exact matches do we widen, and we do that widen
  // concurrently since a fuzzy/cross-provider sweep needs every remaining
  // catalog anyway and gains nothing from doing it one at a time. Explicit
  // --provider never reaches this widen branch at all (see above).
  let groups: ProviderModelGroup[] = [];
  if (order.length > 0) {
    const [firstId, ...restIds] = order;
    const firstGroup = await loadProviderModelGroup(loaderDeps, firstId);
    groups = [firstGroup];

    if (!explicitProvider && restIds.length > 0) {
      const probe = matchModels(groups, parsed);
      const hasEarlyExactMatch = probe.exact && probe.matches.length > 0;

      if (!hasEarlyExactMatch) {
        const restGroups = await collectProviderModelsConcurrently(loaderDeps, restIds);
        groups = [firstGroup, ...restGroups];
      } else {
        // The first provider already resolved an exact match, so a full
        // network load of the rest would only be there to rule out a
        // same-id collision — not worth giving back the latency win early
        // exit was built for. Instead, peek whatever's ALREADY warm (memory
        // cache, or a non-expired disk cache) for the providers we chose not
        // to load: read-only, no fetch, costs nothing when cold. If one of
        // them already has this exact id, fold it in so the normal
        // multiple-matches path asks the user instead of silently picking
        // the first provider tried. Accepted residual limitation: a
        // collision sitting on a provider whose cache is cold or expired
        // goes undetected — that's intentional, not a bug, since ruling it
        // out would require the network fetch this path exists to avoid.
        const peekedGroups: ProviderModelGroup[] = [];
        for (const id of restIds) {
          const models = peekCachedModels(id);
          if (models && models.length > 0) {
            const label = getProvider(id)?.label;
            peekedGroups.push({ provider: id, ...(label ? { label } : {}), models });
          }
        }
        if (peekedGroups.length > 0) {
          groups = [firstGroup, ...peekedGroups];
        }
      }
    }
  }

  // Only providers we actually attempted to load can have failed; a provider
  // skipped entirely by the early-exit/narrow-first strategy above must not
  // appear here; do not let the laziness optimization hide a real outage on a
  // provider that was loaded.
  const warnings = [
    ...(nicknameVanishedWarning ? [nicknameVanishedWarning] : []),
    ...(favoriteVanishedWarning ? [favoriteVanishedWarning] : []),
    ...groups.filter((group) => group.error !== undefined).map((group) => `warning: ${group.provider}: ${group.error}`),
  ];

  const totalLoadedModels = groups.reduce((acc, g) => acc + g.models.length, 0);

  // If providers yielded 0 models, pass through rather than blocking startup
  if (totalLoadedModels === 0) {
    return {
      status: 'passthrough',
      // Fail open with the flag as typed, matching pre-resolution behavior.
      modelId: parsed.rawPattern,
      provider: parsed.provider,
      reasoningEffort: parsed.reasoningEffort,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const { matches } = matchModels(groups, parsed);

  if (matches.length === 0) {
    // If the target provider failed to fetch its catalog or yielded 0 models, allow passthrough
    if (parsed.provider) {
      const targetGroup = groups.find((g) => g.provider.toLowerCase() === parsed.provider!.toLowerCase());
      if (targetGroup?.error || targetGroup?.models.length === 0) {
        return {
          status: 'passthrough',
          modelId: parsed.rawPattern,
          provider: parsed.provider,
          reasoningEffort: parsed.reasoningEffort,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }

      if (targetGroup) {
        const cacheFilePath = getModelCacheFilePath(targetGroup.provider);
        if (deps.interactivePicker) {
          const picked = await deps.interactivePicker({
            initialQuery: parsed.pattern,
            lockProvider: explicitProvider ? parsed.provider : undefined,
            bannerLines: [
              `No models match "${deps.modelFlag}".`,
              `The cached catalog for ${targetGroup.provider} may be stale — delete ${cacheFilePath} to refetch.`,
            ],
          });
          if (!picked) return { status: 'cancelled', error: 'Cancelled.' };
          return {
            status: 'resolved',
            modelId: picked.modelId,
            provider: picked.provider,
            reasoningEffort: parsed.reasoningEffort,
            ...(warnings.length > 0 ? { warnings } : {}),
          };
        }
        return {
          status: 'no_match',
          error: `Error: No models match "${deps.modelFlag}". The cached catalog for ${targetGroup.provider} may be stale — delete ${cacheFilePath} to refetch.`,
        };
      }
    }

    if (deps.interactivePicker) {
      const picked = await deps.interactivePicker({
        initialQuery: parsed.pattern,
        lockProvider: explicitProvider ? parsed.provider : undefined,
        bannerLines: [`No models match "${deps.modelFlag}".`],
      });
      if (!picked) return { status: 'cancelled', error: 'Cancelled.' };
      return {
        status: 'resolved',
        modelId: picked.modelId,
        provider: picked.provider,
        reasoningEffort: parsed.reasoningEffort,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    return {
      status: 'no_match',
      error: `Error: No models match "${deps.modelFlag}".`,
    };
  }

  if (matches.length === 1) {
    return {
      status: 'resolved',
      modelId: matches[0].model.id,
      provider: matches[0].provider,
      reasoningEffort: parsed.reasoningEffort,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  // Ambiguous match: disambiguate. The interactive picker, when available,
  // replaces the readline prompt entirely and browses the FULL catalog
  // (seeded with the typed pattern) rather than only the ambiguous subset,
  // since it lets the user keep narrowing past what --model alone matched.
  if (deps.interactivePicker) {
    const picked = await deps.interactivePicker({
      initialQuery: parsed.pattern,
      initialProvider: matches[0].provider,
      lockProvider: explicitProvider ? parsed.provider : undefined,
    });
    if (!picked) return { status: 'cancelled', error: 'Cancelled.' };
    return {
      status: 'resolved',
      modelId: picked.modelId,
      provider: picked.provider,
      reasoningEffort: parsed.reasoningEffort,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  const selected = await promptForDisambiguation(matches, groups, deps.modelFlag, deps.prompter, deps.streams);

  if (!selected) {
    return {
      status: 'cancelled',
      error: 'Cancelled.',
    };
  }

  return {
    status: 'resolved',
    modelId: selected.model.id,
    provider: selected.provider,
    reasoningEffort: parsed.reasoningEffort,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
