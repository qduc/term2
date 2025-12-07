import {
    Agent,
    ModelBehaviorError,
    UserError,
    run,
    tool as createTool,
    webSearchTool,
    type Tool,
} from '@openai/agents';
import {setDefaultModelProvider} from '@openai/agents-core';
import {OpenRouterProvider} from '../providers/openrouter.js';
import {type ModelSettingsReasoningEffort} from '@openai/agents-core/model';
import {randomUUID} from 'node:crypto';
import {DEFAULT_MODEL, getAgentDefinition} from '../agent.js';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
    #agent: Agent;
    #model!: string;
    // Accept 'default' here to denote 'do not pass this param; use API default'
    #reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    #provider: string;
    #maxTurns: number;
    #retryAttempts: number;
    #currentAbortController: AbortController | null = null;
    #currentCorrelationId: string | null = null;

    constructor({
        model,
        reasoningEffort,
        maxTurns,
        retryAttempts,
    }: {
        model?: string;
        reasoningEffort?: ModelSettingsReasoningEffort | 'default';
        maxTurns?: number;
        retryAttempts?: number;
    } = {}) {
        this.#reasoningEffort = reasoningEffort;
        this.#provider = settingsService.get<string>('agent.provider') || 'openai';
        this.#maxTurns = maxTurns ?? 20;
        this.#retryAttempts = retryAttempts ?? 2;
        this.#agent = this.#createAgent({model, reasoningEffort});
        loggingService.info('OpenAI Agent Client initialized', {
            model: model || DEFAULT_MODEL,
            reasoningEffort: reasoningEffort ?? 'default',
            maxTurns: this.#maxTurns,
            retryAttempts: this.#retryAttempts,
        });
    }

    setModel(model: string): void {
        this.#agent = this.#createAgent({
            model,
            reasoningEffort: this.#reasoningEffort,
        });
    }

    setReasoningEffort(
        effort?: ModelSettingsReasoningEffort | 'default',
    ): void {
        this.#reasoningEffort = effort;
        this.#agent = this.#createAgent({
            model: this.#model,
            reasoningEffort: effort,
        });
    }

    setProvider(provider: string): void {
        this.#provider = provider;
        this.#agent = this.#createAgent({
            model: this.#model,
            reasoningEffort: this.#reasoningEffort,
        });
    }

    /**
     * Abort the current running stream/operation
     */
    abort(): void {
        if (this.#currentAbortController) {
            this.#currentAbortController.abort();
            this.#currentAbortController = null;
        }
        if (this.#currentCorrelationId) {
            loggingService.clearCorrelationId();
            this.#currentCorrelationId = null;
        }
        loggingService.debug('Agent operation aborted');
    }

    async startStream(
        userInput: string,
        {previousResponseId}: {previousResponseId?: string | null} = {},
    ): Promise<any> {
        // Abort any previous operation
        this.abort();

        // Create correlation ID for this stream
        this.#currentCorrelationId = randomUUID();
        loggingService.setCorrelationId(this.#currentCorrelationId);

        this.#currentAbortController = new AbortController();
        const signal = this.#currentAbortController.signal;

        loggingService.info('Agent stream started', {
            inputLength: userInput.length,
            hasPreviousResponseId: !!previousResponseId,
        });

        try {
            const result = await this.#executeWithRetry(() =>
                run(this.#agent, userInput, {
                    previousResponseId: previousResponseId ?? undefined,
                    stream: true,
                    maxTurns: this.#maxTurns,
                    signal,
                }),
            );
            return result;
        } catch (error: any) {
            loggingService.error('Agent stream failed', {
                error: error instanceof Error ? error.message : String(error),
                inputLength: userInput.length,
            });
            throw error;
        }
    }

    async continueRun(state: any): Promise<any> {
        this.abort();
        this.#currentAbortController = new AbortController();
        const signal = this.#currentAbortController.signal;

        return this.#executeWithRetry(() => run(this.#agent, state, {signal}));
    }

    async continueRunStream(state: any): Promise<any> {
        this.abort();
        this.#currentAbortController = new AbortController();
        const signal = this.#currentAbortController.signal;

        return this.#executeWithRetry(() =>
            run(this.#agent, state, {
                stream: true,
                maxTurns: this.#maxTurns,
                signal,
            }),
        );
    }

    async #executeWithRetry<T>(
        operation: () => Promise<T>,
        retries = this.#retryAttempts,
    ): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (
                retries > 0 &&
                (error instanceof UserError ||
                    error instanceof ModelBehaviorError)
            ) {
                loggingService.warn('Agent operation retry', {
                    errorType: error.constructor.name,
                    retriesRemaining: retries - 1,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                });
                return this.#executeWithRetry(operation, retries - 1);
            }
            throw error;
        }
    }

    #createAgent({
        model,
        reasoningEffort,
    }: {
        model?: string;
        reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    } = {}): Agent {
        const resolvedModel = model?.trim() || DEFAULT_MODEL;
        this.#model = resolvedModel;
        const {
            name,
            instructions,
            tools: toolDefinitions,
        } = getAgentDefinition(resolvedModel);

        const tools: Tool[] = toolDefinitions.map(definition =>
            createTool({
                name: definition.name,
                description: definition.description,
                parameters: definition.parameters,
                needsApproval: async (context, params) =>
                    definition.needsApproval(params, context),
                execute: async params => definition.execute(params),
            }),
        );

        // Add web search tool. If the user explicitly selected 'minimal' we
        // disable it; if they selected 'default', we don't influence the
        // decision and leave the web tool enabled.
        if (reasoningEffort !== 'minimal') {
            tools.push(webSearchTool());
        }

        // Build modelSettings only if an explicit effort value (other than
        // 'default') was provided. 'default' means we should not pass the
        // effort param and allow the underlying API to choose the default.
        const modelSettings: any = {};
        if (reasoningEffort && reasoningEffort !== 'default') {
            modelSettings.reasoning = {
                effort: reasoningEffort,
                summary: 'auto',
            };
        }

        // Switch to OpenRouter provider based on config setting
        if (
            this.#provider === 'openrouter' &&
            process.env.OPENROUTER_API_KEY
        ) {
            setDefaultModelProvider(new OpenRouterProvider());
        }

        const agent = new Agent({
            name,
            model: resolvedModel,
            ...(Object.keys(modelSettings).length > 0 ? {modelSettings} : {}),
            instructions,
            tools,
        });

        // Only add defaultRunOptions if an explicit effort is set (not
        // 'default'). This ensures the API receives the param only when
        // intended.
        if (reasoningEffort && reasoningEffort !== 'default') {
            (agent as any).defaultRunOptions = {
                ...((agent as any).defaultRunOptions || {}),
                // Pass through to underlying client for models that support it
                reasoning: {effort: reasoningEffort},
            };
        }

        return agent;
    }
}
