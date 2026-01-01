import {OpenAIAgentClient} from '../../lib/openai-agent-client.js';
import type {ContextBuffer} from './context-buffer.js';
import type {Summarizer} from './summarizer.js';
import type {ISettingsService, ILoggingService} from '../../services/service-interfaces.js';
import {generateCommandIndexPrompt} from './command-index.js';

export interface CompanionSessionDeps {
    contextBuffer: ContextBuffer;
    summarizer: Summarizer;
    settings: ISettingsService;
    logger: ILoggingService;
}

export type CompanionMode = 'watch' | 'auto';

export interface CompanionEvent {
    type: 'text' | 'tool_call' | 'complete' | 'error' | 'approval_required' | 'blocked';
    content?: string;
    tool?: string;
    args?: unknown;
    safety?: 'green' | 'yellow' | 'red';
    reason?: string;
}

/**
 * Lightweight session for companion mode queries.
 *
 * Unlike chat mode's ConversationSession:
 * - No persistent conversation history (each query is standalone)
 * - No previousResponseId chaining
 * - Simpler approval flow (Auto mode only)
 */
export class CompanionSession {
    #agentClient: OpenAIAgentClient | null = null;
    #contextBuffer: ContextBuffer;
    #summarizer: Summarizer;
    #settings: ISettingsService;
    #logger: ILoggingService;
    #currentMode: CompanionMode = 'watch';

    constructor(deps: CompanionSessionDeps) {
        this.#contextBuffer = deps.contextBuffer;
        this.#summarizer = deps.summarizer;
        this.#settings = deps.settings;
        this.#logger = deps.logger;
    }

    /**
     * Get the summarizer instance (for terminal_history tool integration).
     */
    get summarizer(): Summarizer {
        return this.#summarizer;
    }

    get mode(): CompanionMode {
        return this.#currentMode;
    }

    setMode(mode: CompanionMode): void {
        this.#currentMode = mode;
        this.#logger.info(`Companion mode changed to: ${mode}`);
    }

    /**
     * Handle a ?? query in Watch mode.
     * Creates ephemeral session, streams response, then disposes.
     */
    async *handleWatchQuery(query: string): AsyncGenerator<CompanionEvent> {
        try {
            const client = this.#getOrCreateClient();
            const commandIndex = this.#contextBuffer.getIndex();
            const contextPrompt = generateCommandIndexPrompt(commandIndex);

            // Build the full query with context
            const fullQuery = query
                ? `${contextPrompt}\n\nUser question: ${query}`
                : `${contextPrompt}\n\nThe user typed ?? for help. Analyze the recent commands and provide helpful suggestions.`;

            this.#logger.info('Handling watch query', {
                query: query.slice(0, 100),
                commandCount: commandIndex.length,
            });

            // Stream response using existing API
            const stream = await client.startStream(fullQuery);

            for await (const event of stream) {
                if (event?.type === 'text_delta' || event?.data?.type === 'output_text') {
                    const delta = event?.data?.delta ?? event?.delta ?? '';
                    if (delta) {
                        yield {type: 'text', content: delta};
                    }
                }
            }

            yield {type: 'complete'};
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#logger.error('Watch query failed', {error: message});
            yield {type: 'error', content: message};
        }
    }

    /**
     * Handle !auto task in Auto mode.
     * Full agent loop with tool execution.
     */
    async *handleAutoTask(task: string): AsyncGenerator<CompanionEvent> {
        this.setMode('auto');

        try {
            const client = this.#getOrCreateClient();
            const commandIndex = this.#contextBuffer.getIndex();
            const contextPrompt = generateCommandIndexPrompt(commandIndex);

            const fullTask = `${contextPrompt}\n\nUser task: ${task}\n\nYou are in Auto mode. Execute commands to complete this task. Use the shell tool to run commands.`;

            this.#logger.info('Handling auto task', {
                task: task.slice(0, 100),
                commandCount: commandIndex.length,
            });

            // Stream response using existing API
            const stream = await client.startStream(fullTask);

            for await (const event of stream) {
                if (event?.type === 'text_delta' || event?.data?.type === 'output_text') {
                    const delta = event?.data?.delta ?? event?.delta ?? '';
                    if (delta) {
                        yield {type: 'text', content: delta};
                    }
                }

                // Check for tool calls
                if (event?.type === 'tool_call' || event?.item?.type === 'function_call') {
                    const toolName =
                        event?.name ?? event?.item?.name ?? event?.item?.rawItem?.name;
                    const toolArgs =
                        event?.arguments ?? event?.item?.arguments ?? event?.item?.rawItem?.arguments;

                    if (toolName) {
                        yield {
                            type: 'tool_call',
                            tool: toolName,
                            args: toolArgs,
                        };
                    }
                }
            }

            yield {type: 'complete'};
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.#logger.error('Auto task failed', {error: message});
            yield {type: 'error', content: message};
        } finally {
            this.setMode('watch');
        }
    }

    /**
     * Abort the current operation.
     */
    abort(): void {
        if (this.#agentClient) {
            this.#agentClient.abort();
        }
        this.setMode('watch');
    }

    /**
     * Get or create the agent client.
     */
    #getOrCreateClient(): OpenAIAgentClient {
        if (!this.#agentClient) {
            this.#agentClient = new OpenAIAgentClient({
                model: this.#settings.get('agent.model'),
                reasoningEffort: this.#settings.get('agent.reasoningEffort'),
                maxTurns: 10, // Lower than chat mode - companion queries should be quick
                deps: {
                    settings: this.#settings,
                    logger: this.#logger,
                },
            });
        }
        return this.#agentClient;
    }
}
