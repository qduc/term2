import OpenAI from 'openai';
import type {ISettingsService, ILoggingService} from '../../services/service-interfaces.js';
import type {CommandEntry} from './context-buffer.js';
import {classifyOutputType, getSummarizationPrompt, shouldSummarize} from './output-classifier.js';

export interface SummarizerDeps {
    settings: ISettingsService;
    logger: ILoggingService;
}

interface CacheEntry {
    summary: string;
    timestamp: number;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Summarizer for command outputs using a small, fast LLM.
 * Caches summaries to avoid reprocessing.
 */
export class Summarizer {
    #client: OpenAI | null = null;
    #settings: ISettingsService;
    #logger: ILoggingService;
    #cache: Map<string, CacheEntry> = new Map();

    constructor(deps: SummarizerDeps) {
        this.#settings = deps.settings;
        this.#logger = deps.logger;
    }

    /**
     * Summarize command output.
     * Returns the original output if summarization is not needed or fails.
     */
    async summarize(
        entry: CommandEntry,
        detail: 'summary' | 'errors_only',
    ): Promise<string> {
        // Check if summarization is needed
        if (!shouldSummarize(entry)) {
            return entry.output;
        }

        // Check cache
        const cacheKey = this.#getCacheKey(entry, detail);
        const cached = this.#cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return cached.summary;
        }

        try {
            const client = await this.#getClient();
            const model = this.#settings.get<string>('companion.summarizerModel') || 'gpt-4o-mini';
            const maxTokens = this.#settings.get<number>('companion.summarizerMaxTokens') || 500;

            const outputType = classifyOutputType(entry);
            const prompt = this.#buildPrompt(entry, detail, outputType);

            const response = await client.chat.completions.create({
                model,
                max_tokens: maxTokens,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a concise technical summarizer. Extract key information only.',
                    },
                    {role: 'user', content: prompt},
                ],
            });

            const summary = response.choices[0]?.message?.content || entry.output;

            // Cache result
            this.#cache.set(cacheKey, {summary, timestamp: Date.now()});

            return summary;
        } catch (error) {
            this.#logger.warn('Summarization failed, using fallback', {
                error: error instanceof Error ? error.message : String(error),
                command: entry.command.slice(0, 50),
            });

            // Fallback: smart truncation
            return this.#fallbackSummarize(entry, detail);
        }
    }

    /**
     * Clear the summary cache.
     */
    clearCache(): void {
        this.#cache.clear();
    }

    /**
     * Get or create OpenAI client.
     */
    async #getClient(): Promise<OpenAI> {
        if (this.#client) {
            return this.#client;
        }

        const provider = this.#settings.get<string>('companion.summarizerProvider') || 'openai';

        // Use OpenAI API key from environment
        const apiKey = process.env.OPENAI_API_KEY;

        // For non-OpenAI providers, get baseURL from settings
        const baseURL =
            provider === 'openai'
                ? undefined
                : this.#settings.get<string>(`agent.${provider}.baseUrl`);

        if (!apiKey) {
            throw new Error('OPENAI_API_KEY not set');
        }

        this.#client = new OpenAI({apiKey, baseURL});
        return this.#client;
    }

    /**
     * Build the summarization prompt.
     */
    #buildPrompt(
        entry: CommandEntry,
        detail: 'summary' | 'errors_only',
        outputType: string,
    ): string {
        const basePrompt = getSummarizationPrompt(outputType as any);

        return `Command: ${entry.command}
Exit code: ${entry.exitCode}

Output:
\`\`\`
${entry.output}
\`\`\`

${detail === 'errors_only' ? getSummarizationPrompt('error_output') : basePrompt}`;
    }

    /**
     * Fallback summarization without LLM.
     */
    #fallbackSummarize(
        entry: CommandEntry,
        detail: 'summary' | 'errors_only',
    ): string {
        const lines = entry.output.split('\n');

        if (detail === 'errors_only') {
            // Extract lines containing common error patterns
            const errorPatterns = /error|fail|exception|fatal|critical|warning/i;
            const errorLines = lines.filter(l => errorPatterns.test(l));
            return errorLines.slice(0, 20).join('\n') || 'No obvious errors found';
        }

        // Default: first and last N lines
        if (lines.length <= 30) {
            return entry.output;
        }

        return [
            ...lines.slice(0, 15),
            `... (${lines.length - 30} lines omitted)`,
            ...lines.slice(-15),
        ].join('\n');
    }

    /**
     * Generate cache key for an entry.
     */
    #getCacheKey(entry: CommandEntry, detail: string): string {
        return `${entry.command}:${entry.timestamp}:${detail}`;
    }
}
