import {Agent, run, type Runner} from '@openai/agents';
import type {SearchReplaceToolParams} from './search-replace.js';
import type {
    ILoggingService,
    ISettingsService,
} from '../services/service-interfaces.js';
import {getProvider} from '../providers/index.js';

export interface HealingResult {
    params: SearchReplaceToolParams;
    wasModified: boolean;
    confidence: number;
}

type HealingDeps = {
    settingsService?: ISettingsService;
    loggingService?: ILoggingService;
    providerId?: string;
    timeoutMs?: number;
    confidenceThreshold?: number;
    maxFileChars?: number;
    runModel?: (
        prompt: string,
        meta: {
            model: string;
            apiKey: string;
            timeoutMs: number;
            providerId: string;
        },
    ) => Promise<string>;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_MAX_FILE_CHARS = 8000;

function buildPrompt(searchContent: string, fileContent: string): string {
    return [
        'The user wants to replace this text in a file:',
        '<search>',
        searchContent,
        '</search>',
        '',
        "But it doesn't exactly match the file. Here's the file content:",
        '<file>',
        fileContent,
        '</file>',
        '',
        'Find the section in the file that most closely matches the search text and output ONLY the exact text from the file that should be matched.',
        'If there is no reasonable match, output "NO_MATCH".',
        'Do not add any commentary or code fences.',
    ].join('\n');
}

function extractFileExcerpt(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    const head = content.slice(0, Math.floor(maxChars / 2));
    const tail = content.slice(-Math.floor(maxChars / 2));
    return `${head}\n...<truncated>...\n${tail}`;
}

function stripCodeFences(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
        return trimmed.replace(/^```[a-zA-Z0-9-]*\n?/, '').replace(/```$/, '').trim();
    }
    return trimmed;
}

function extractModelText(result: any): string {
    if (typeof result?.finalOutput === 'string') return result.finalOutput;
    const messages = result?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return '';
    const last = messages[messages.length - 1];
    const content = last?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map((part: any) => part?.text || part?.value || '').join('');
    }
    return '';
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count++;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function computeSimilarity(a: string, b: string): number {
    const aNorm = normalizeWhitespace(a);
    const bNorm = normalizeWhitespace(b);
    if (!aNorm || !bNorm) return 0;

    const tokenCoverage = computeTokenCoverage(aNorm, bNorm);

    const matrix: number[][] = Array.from({length: aNorm.length + 1}, () =>
        new Array(bNorm.length + 1).fill(0),
    );

    for (let i = 0; i <= aNorm.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= bNorm.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= aNorm.length; i++) {
        for (let j = 1; j <= bNorm.length; j++) {
            const cost = aNorm[i - 1] === bNorm[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost,
            );
        }
    }

    const distance = matrix[aNorm.length][bNorm.length];
    const maxLen = Math.max(aNorm.length, bNorm.length);
    const levenshteinScore = maxLen === 0 ? 0 : 1 - distance / maxLen;
    return Math.max(levenshteinScore, tokenCoverage);
}

function computeTokenCoverage(search: string, candidate: string): number {
    const searchTokens = search.match(/\w+/g) ?? [];
    const candidateTokens = new Set(candidate.match(/\w+/g) ?? []);
    if (searchTokens.length === 0) return 0;
    let matches = 0;
    for (const token of searchTokens) {
        if (candidateTokens.has(token)) {
            matches += 1;
        }
    }
    return matches / searchTokens.length;
}

async function runHealingPrompt(
    prompt: string,
    model: string,
    apiKey: string,
    deps: Required<Pick<HealingDeps, 'settingsService' | 'loggingService' | 'providerId' | 'timeoutMs'>>,
): Promise<string> {
    const {settingsService, loggingService, providerId, timeoutMs} = deps;
    let runner: Runner | null = null;

    if (providerId !== 'openai') {
        const providerDef = getProvider(providerId);
        runner = providerDef?.createRunner
            ? providerDef.createRunner({
                  settingsService,
                  loggingService,
              })
            : null;

        if (!runner) {
            const label = providerDef?.label || providerId;
            throw new Error(
                `${label} is configured but could not be initialized. Check credentials.`,
            );
        }
    }

    const agent = new Agent({
        name: 'EditHealer',
        model,
        instructions:
            'You are a text matching assistant. Return only exact text from the file or NO_MATCH.',
    });

    const options: any = {
        stream: false,
        maxTurns: 1,
    };
    if (providerId !== 'openai') {
        options.tracingDisabled = true;
    }

    let previousApiKey: string | undefined;
    if (providerId === 'openai' && apiKey && !process.env.OPENAI_API_KEY) {
        previousApiKey = process.env.OPENAI_API_KEY;
        process.env.OPENAI_API_KEY = apiKey;
    }

    try {
        const runPromise = runner
            ? runner.run(agent, prompt, options)
            : run(agent, prompt, options);

        const result = await Promise.race([
            runPromise,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('Edit healing timed out')),
                    timeoutMs,
                ),
            ),
        ]);

        return extractModelText(result);
    } finally {
        if (providerId === 'openai' && apiKey && previousApiKey === undefined) {
            delete process.env.OPENAI_API_KEY;
        } else if (providerId === 'openai' && apiKey && previousApiKey !== undefined) {
            process.env.OPENAI_API_KEY = previousApiKey;
        }
    }
}

export async function healSearchReplaceParams(
    originalParams: SearchReplaceToolParams,
    fileContent: string,
    model: string,
    apiKey: string,
    deps: HealingDeps = {},
): Promise<HealingResult> {
    const providerId = deps.providerId ?? deps.settingsService?.get<string>('agent.provider') ?? 'openai';
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const confidenceThreshold =
        deps.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const maxFileChars = deps.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;

    const prompt = buildPrompt(
        originalParams.search_content,
        extractFileExcerpt(fileContent, maxFileChars),
    );

    let modelOutput = '';
    try {
        if (deps.runModel) {
            modelOutput = await deps.runModel(prompt, {
                model,
                apiKey,
                timeoutMs,
                providerId,
            });
        } else if (deps.settingsService && deps.loggingService) {
            modelOutput = await runHealingPrompt(prompt, model, apiKey, {
                settingsService: deps.settingsService,
                loggingService: deps.loggingService,
                providerId,
                timeoutMs,
            });
        } else {
            throw new Error('Missing settings/logging services for edit healing');
        }
    } catch (error: any) {
        deps.loggingService?.warn('Edit healing failed', {
            error: error?.message || String(error),
        });
        return {
            params: originalParams,
            wasModified: false,
            confidence: 0,
        };
    }

    const cleaned = stripCodeFences(modelOutput).trim();
    if (!cleaned || cleaned.toUpperCase() === 'NO_MATCH') {
        return {
            params: originalParams,
            wasModified: false,
            confidence: 0,
        };
    }

    if (!fileContent.includes(cleaned)) {
        return {
            params: originalParams,
            wasModified: false,
            confidence: 0,
        };
    }

    if (countOccurrences(fileContent, cleaned) > 1) {
        return {
            params: originalParams,
            wasModified: false,
            confidence: 0,
        };
    }

    const confidence = computeSimilarity(originalParams.search_content, cleaned);
    if (confidence < confidenceThreshold) {
        return {
            params: originalParams,
            wasModified: false,
            confidence,
        };
    }

    return {
        params: {
            ...originalParams,
            search_content: cleaned,
        },
        wasModified: cleaned !== originalParams.search_content,
        confidence,
    };
}
