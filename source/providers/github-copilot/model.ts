import {
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import { CopilotClient } from '@github/copilot-sdk';
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import {
    buildMessagesFromRequest,
    normalizeUsage,
} from './converters.js';

// Singleton client - SDK manages CLI process lifecycle
let sharedClient: CopilotClient | null = null;

async function getClient(): Promise<CopilotClient> {
    if (!sharedClient) {
        sharedClient = new CopilotClient();
        await sharedClient.start();
    }
    return sharedClient;
}

/**
 * Force stop the shared client (for cleanup/error recovery)
 */
export async function forceStopClient(): Promise<void> {
    if (sharedClient) {
        try {
            await sharedClient.forceStop();
        } catch {
            // Ignore errors during cleanup
        }
        sharedClient = null;
    }
}

export class GitHubCopilotModel implements Model {
    name: string;
    #modelId: string;
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        modelId?: string;
    }) {
        this.name = 'GitHubCopilot';
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#modelId =
            deps.modelId ||
            this.#settingsService.get('agent.github-copilot.model') ||
            this.#settingsService.get('agent.model') ||
            'gpt-4o';
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        // For non-streaming requests, collect all events and build response
        const events: ResponseStreamEvent[] = [];

        for await (const event of this.getStreamedResponse(request)) {
            events.push(event);
        }

        // Find the response_done event
        const doneEvent = events.find((e: any) => e.type === 'response_done') as any;

        if (doneEvent?.response) {
            return {
                responseId: doneEvent.response.id || randomUUID(),
                output: doneEvent.response.output || [],
                usage: normalizeUsage(doneEvent.response.usage) as any,
            };
        }

        // Fallback: build response from accumulated events
        const textDeltas = events
            .filter((e: any) => e.type === 'output_text_delta')
            .map((e: any) => e.delta)
            .join('');

        return {
            responseId: randomUUID(),
            output: textDeltas ? [{
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: textDeltas }],
            }] : [],
            usage: normalizeUsage({}) as any,
        };
    }

    async *getStreamedResponse(
        request: ModelRequest,
    ): AsyncIterable<ResponseStreamEvent> {
        const client = await getClient();
        const resolvedModelId = this.#resolveModelFromRequest(request) || this.#modelId;
        const messages = buildMessagesFromRequest(
            request,
            resolvedModelId,
            this.#loggingService,
        );

        this.#loggingService.debug('GitHubCopilot stream start', {
            messageCount: messages.length,
            modelId: resolvedModelId,
        });

        let session;
        try {
            // Create a session with the Copilot SDK
            // Note: Tools are defined on the session, not passed in the request.
            // The SDK manages tool registration separately.
            session = await client.createSession({
                model: resolvedModelId,
                streaming: true,
            });
        } catch (err: any) {
            this.#loggingService.error('GitHubCopilot session creation failed', {
                error: err.message,
            });
            // Emit error as a model event since ResponseStreamEvent doesn't have error type
            yield {
                type: 'model',
                event: { type: 'error', message: `Failed to create Copilot session: ${err.message}` },
            } as ResponseStreamEvent;
            return;
        }

        const state = {
            accumulated: '',
            accumulatedReasoningText: '',
            accumulatedToolCalls: [] as any[],
            responseId: randomUUID(),
            usageData: null as any,
        };

        // Set up event handlers and collect events via async iteration
        const eventQueue: ResponseStreamEvent[] = [];
        let resolveNext: ((value: IteratorResult<ResponseStreamEvent>) => void) | null = null;
        let done = false;
        let error: Error | null = null;

        const pushEvent = (event: ResponseStreamEvent) => {
            if (resolveNext) {
                resolveNext({ value: event, done: false });
                resolveNext = null;
            } else {
                eventQueue.push(event);
            }
        };

        const finish = (err?: Error) => {
            done = true;
            error = err || null;
            if (resolveNext) {
                if (err) {
                    resolveNext = null;
                    throw err;
                }
                resolveNext({ value: undefined as any, done: true });
                resolveNext = null;
            }
        };

        // Register event handlers on the session
        session.on((event: any) => {
            try {
                switch (event.type) {
                    case 'assistant.message_delta':
                        // Streaming text chunk
                        if (event.data?.deltaContent) {
                            state.accumulated += event.data.deltaContent;
                            pushEvent({
                                type: 'output_text_delta',
                                delta: event.data.deltaContent,
                            } as ResponseStreamEvent);
                        }
                        break;

                    case 'assistant.reasoning_delta':
                        // Streaming reasoning (O1/O3 models)
                        if (event.data?.deltaContent) {
                            state.accumulatedReasoningText += event.data.deltaContent;
                            // Emit as model event for reasoning channel
                            pushEvent({
                                type: 'model',
                                event: {
                                    type: 'reasoning_delta',
                                    content: event.data.deltaContent,
                                },
                            } as ResponseStreamEvent);
                        }
                        break;

                    case 'tool.execution_start':
                        // Tool call requested
                        if (event.data) {
                            const toolCall = {
                                type: 'function_call',
                                callId: event.data.callId || randomUUID(),
                                name: event.data.toolName,
                                arguments: typeof event.data.args === 'string'
                                    ? event.data.args
                                    : JSON.stringify(event.data.args || {}),
                            };
                            state.accumulatedToolCalls.push(toolCall);

                            // We don't emit tool calls during streaming - they're handled
                            // in the response_done event
                        }
                        break;

                    case 'session.usage':
                        // Usage data
                        if (event.data) {
                            state.usageData = event.data;
                        }
                        break;

                    case 'session.idle':
                        // Session complete - emit response_done
                        this.#loggingService.debug('GitHubCopilot stream done', {
                            text: state.accumulated,
                            toolCalls: state.accumulatedToolCalls.length,
                        });

                        const output = this.#buildStreamOutput(state);
                        pushEvent({
                            type: 'response_done',
                            response: {
                                id: state.responseId,
                                usage: normalizeUsage(state.usageData),
                                output,
                            },
                        } as ResponseStreamEvent);

                        finish();
                        break;

                    case 'session.error':
                        // Handle errors
                        this.#loggingService.error('GitHubCopilot session error', {
                            error: event.data?.message,
                        });
                        // Emit error as a model event since ResponseStreamEvent doesn't have error type
                        pushEvent({
                            type: 'model',
                            event: { type: 'error', message: event.data?.message || 'Unknown error' },
                        } as ResponseStreamEvent);
                        finish(new Error(event.data?.message || 'Session error'));
                        break;
                }
            } catch (err: any) {
                this.#loggingService.error('GitHubCopilot event processing error', {
                    error: err.message,
                    eventType: event.type,
                });
            }
        });

        // Send the messages to start the conversation
        try {
            // Build the prompt from the last user message
            const lastUserMessage = messages.filter(m => m.role === 'user').pop();
            const prompt = lastUserMessage?.content || '';

            // Send with conversation history
            await session.send({
                prompt,
                // Pass conversation history if the SDK supports it
                messages: messages.slice(0, -1), // Exclude the prompt message
            });
        } catch (err: any) {
            this.#loggingService.error('GitHubCopilot send failed', {
                error: err.message,
            });
            // Emit error as a model event since ResponseStreamEvent doesn't have error type
            yield {
                type: 'model',
                event: { type: 'error', message: `Failed to send message: ${err.message}` },
            } as ResponseStreamEvent;

            // Try to abort the session
            try {
                await session.abort();
            } catch {
                // Ignore abort errors
            }
            return;
        }

        // Yield events as they come in
        while (!done || eventQueue.length > 0) {
            if (eventQueue.length > 0) {
                yield eventQueue.shift()!;
            } else if (!done) {
                // Wait for next event
                yield await new Promise<ResponseStreamEvent>((resolve) => {
                    resolveNext = (result) => {
                        if (result.done) {
                            // Signal completion
                            resolve({ type: 'model', event: '[DONE]' } as ResponseStreamEvent);
                        } else {
                            resolve(result.value);
                        }
                    };
                });
            }
        }

        if (error) {
            throw error;
        }
    }

    #buildStreamOutput(state: {
        accumulated: string;
        accumulatedReasoningText: string;
        accumulatedToolCalls: any[];
    }): any[] {
        const output: any[] = [];

        // Add assistant message if there's text content
        if (state.accumulated) {
            output.push({
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: state.accumulated }],
                ...(state.accumulatedReasoningText
                    ? { reasoning: state.accumulatedReasoningText }
                    : {}),
            });
        }

        // Add tool calls as separate output items
        for (const toolCall of state.accumulatedToolCalls) {
            output.push({
                type: 'function_call',
                callId: toolCall.callId,
                name: toolCall.name,
                arguments: toolCall.arguments,
                status: 'completed',
                ...(state.accumulatedReasoningText
                    ? { reasoning: state.accumulatedReasoningText }
                    : {}),
            });
        }

        return output;
    }

    #resolveModelFromRequest(req: ModelRequest): string | undefined {
        if ((req as any)?.providerData?.model) {
            return (req as any).providerData.model;
        }
        return undefined;
    }
}
