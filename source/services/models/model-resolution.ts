import { createInterface } from 'node:readline';
import { getProvider, getProviderIds } from '../../providers/index.js';
import { filterModels, type ModelInfo } from '../model-service.js';
import type { ILoggingService, ISettingsService } from '../service-interfaces.js';
import { scoreSubsequence } from '../../utils/subsequence-filter.js';
import { collectProviderModels, type ProviderModelGroup } from './model-listing.js';
import type { ModelFetcher } from './model-catalog-session.js';
import { HARNESS_IDLE_ENV } from '../../lib/harness-input-idle.js';

export const VALID_REASONING_EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type ModelSettingsReasoningEffort = (typeof VALID_REASONING_EFFORTS)[number];

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
  let withoutThinking = trimmed;
  let reasoningEffort: ModelSettingsReasoningEffort | undefined;

  const colonIdx = trimmed.lastIndexOf(':');
  if (colonIdx !== -1) {
    const potentialEffort = trimmed.slice(colonIdx + 1).toLowerCase();
    if ((VALID_REASONING_EFFORTS as readonly string[]).includes(potentialEffort)) {
      reasoningEffort = potentialEffort as ModelSettingsReasoningEffort;
      withoutThinking = trimmed.slice(0, colonIdx).trim();
    }
  }

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

  // Stage 2: Fuzzy / partial matches
  const fuzzyMatches: ModelMatch[] = [];
  const trimmed = parsed.pattern.trim();

  for (const group of groups) {
    if (parsed.provider) {
      if (group.provider.toLowerCase() === parsed.provider.toLowerCase()) {
        const filtered = filterModels(group.models, trimmed);
        for (const model of filtered) {
          fuzzyMatches.push({ provider: group.provider, model });
        }
      }
      continue;
    }

    // No provider specified: match provider name or model id/name
    if (scoreSubsequence(trimmed, group.provider) !== -Infinity) {
      for (const model of group.models) {
        fuzzyMatches.push({ provider: group.provider, model });
      }
    } else {
      const filtered = filterModels(group.models, trimmed);
      for (const model of filtered) {
        fuzzyMatches.push({ provider: group.provider, model });
      }
    }
  }

  return { exact: false, matches: fuzzyMatches };
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
}): Promise<ModelResolutionResult> {
  const knownProviders = deps.knownProviders ?? getProviderIds();
  const parsed = parseModelFlag(deps.modelFlag, {
    providerFlag: deps.providerFlag,
    knownProviders,
  });

  // Isolated black-box provider harnesses replay wire turns and do not mock catalog endpoints
  if (process.env[HARNESS_IDLE_ENV] && deps.prompter === undefined) {
    return {
      status: 'passthrough',
      modelId: parsed.rawPattern,
      provider: parsed.provider,
      reasoningEffort: parsed.reasoningEffort,
    };
  }

  // Narrow the catalog load only when the user explicitly scoped it with
  // --provider. A provider prefix parsed out of the flag itself (e.g. the
  // `anthropic/` in `anthropic/claude-3.5-sonnet` on an aggregator) must not
  // narrow: the full id may be a literal model id on a different provider.
  const providerIds = deps.providerIds ?? (deps.providerFlag && parsed.provider ? [parsed.provider] : undefined);
  const groups = await collectProviderModels(
    {
      settingsService: deps.settingsService,
      loggingService: deps.loggingService,
      fetcher: deps.fetcher,
    },
    providerIds,
  );
  const warnings = groups
    .filter((group) => group.error !== undefined)
    .map((group) => `warning: ${group.provider}: ${group.error}`);

  const totalLoadedModels = groups.reduce((acc, g) => acc + g.models.length, 0);
  const hasFetchErrors = groups.some((g) => g.error !== undefined);

  // If providers had errors and yielded 0 models, pass through rather than blocking startup
  if (totalLoadedModels === 0 && hasFetchErrors) {
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
    // If the target provider failed to fetch its catalog, allow passthrough
    if (parsed.provider) {
      const targetGroup = groups.find((g) => g.provider.toLowerCase() === parsed.provider!.toLowerCase());
      if (targetGroup?.error) {
        return {
          status: 'passthrough',
          modelId: parsed.rawPattern,
          provider: parsed.provider,
          reasoningEffort: parsed.reasoningEffort,
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      }
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

  // Ambiguous match: disambiguate
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
