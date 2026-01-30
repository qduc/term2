import {
    type Model,
    type ModelRequest,
    type ModelResponse,
    type ResponseStreamEvent,
} from '@openai/agents-core';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CopilotClient, type CopilotSession } from '@github/copilot-sdk';

// Load simple.md system prompt (same as other providers)
const SIMPLE_PROMPT_PATH = path.join(import.meta.dirname, '../../prompts/simple.md');
const SIMPLE_PROMPT = fs.readFileSync(SIMPLE_PROMPT_PATH, 'utf-8').trim();
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import {
    buildMessagesFromRequest,
    extractFunctionToolsFromRequest,
    normalizeUsage,
} from './converters.js';

// Global map to store pending tool resolutions: SessionID -> CallID -> ResolveFunction
// This allows us to "detach" the tool execution from the SDK's internal loop
// and hand it over to the Agent Runner, then resume it later.
const pendingResolutions = new Map<string, Map<string, (result: any) => void>>();

// Singleton client - SDK manages CLI process lifecycle
export let sharedClient: CopilotClient | null = null;

export async function getClient(): Promise<CopilotClient> {
    if (!sharedClient) {
        sharedClient = new CopilotClient();
        await sharedClient.start();
    }
    return sharedClient;
}

export function extractCopilotTextDelta(accumulated: string, incoming: string): string {
    if (!incoming) return '';
    if (!accumulated) return incoming;

    // 1. If incoming starts with accumulated, it's definitely an accumulation
    if (incoming.startsWith(accumulated)) {
        return incoming.slice(accumulated.length);
    }

    // 2. Check for overlap: find the longest suffix of 'accumulated' that is a prefix of 'incoming'
    // We only check up to a reasonable length to avoid O(N^2) on very long outputs,
    // though usually deltas are small.
    const maxOverlap = Math.min(accumulated.length, incoming.length);
    for (let len = maxOverlap; len > 0; len--) {
        const suffix = accumulated.slice(-len);
        const prefix = incoming.slice(0, len);
        if (suffix === prefix) {
            return incoming.slice(len);
        }
    }

    // 3. No overlap found, treat as a pure delta
    return incoming;
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
    #sessionMap: Map<string, string>;
    #activeSessions: Map<string, CopilotSession>;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        modelId?: string;
        sessionMap?: Map<string, string>;
        activeSessions?: Map<string, CopilotSession>;
    }) {
        this.name = 'GitHubCopilot';
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#sessionMap = deps.sessionMap || new Map();
        this.#activeSessions = deps.activeSessions || new Map();
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
            previousResponseId: request.previousResponseId,
        });

        const tools = extractFunctionToolsFromRequest(request);
        // Wrap tools with the "Trap" handler that suspends execution
        const copilotTools = tools.map((t: any) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
            handler: async (_args: any, invocation: any) => {
                this.#loggingService.debug('Copilot tool trap activated', {
                    tool: invocation.toolName,
                    callId: invocation.toolCallId,
                });
                return new Promise((resolve) => {
                    if (!pendingResolutions.has(invocation.sessionId)) {
                        pendingResolutions.set(invocation.sessionId, new Map());
                    }
                    pendingResolutions.get(invocation.sessionId)!.set(invocation.toolCallId, resolve);
                });
            },
        }));

        let session: CopilotSession;
        try {
            // Check if we can resume a previous session
            const prevSessionId = request.previousResponseId
                ? this.#sessionMap.get(request.previousResponseId)
                : undefined;

            // First, try to get a cached session object
            const cachedSession = prevSessionId
                ? this.#activeSessions.get(prevSessionId)
                : undefined;

            if (cachedSession) {
                // Reuse the cached session - just update tool handlers with fresh callbacks
                this.#loggingService.debug('Reusing cached GitHubCopilot session', {
                    sessionId: prevSessionId,
                });
                session = cachedSession;
                // Re-register tools to get fresh Promise callbacks for this turn
                (session as any).registerTools(copilotTools);
            } else if (prevSessionId) {
                // Session ID exists but no cached object - need to resume from server
                this.#loggingService.debug('Resuming GitHubCopilot session from server', {
                    sessionId: prevSessionId,
                });
                session = await client.resumeSession(prevSessionId, {
                    streaming: true,
                    tools: copilotTools,
                });
                // Cache the resumed session for future turns
                this.#activeSessions.set(session.sessionId, session);
            } else {
                // No previous session - create a new one
                this.#loggingService.debug('Creating new GitHubCopilot session');
                session = await client.createSession({
                    model: resolvedModelId,
                    streaming: true,
                    tools: copilotTools,
                    availableTools: copilotTools.map((t: any) => t.name),
                    systemMessage: {
                        mode: 'replace',
                        content: SIMPLE_PROMPT,
                    },
                });
                // Cache the new session for future turns
                this.#activeSessions.set(session.sessionId, session);
            }
        } catch (err: any) {
            this.#loggingService.error('GitHubCopilot session creation/resumption failed', {
                error: err.message,
            });
            // Emit error as a model event since ResponseStreamEvent doesn't have error type
            yield {
                type: 'model',
                event: { type: 'error', message: `Failed to create/resume Copilot session: ${err.message}` },
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

        // Track new sessionId for future resumption
        this.#sessionMap.set(state.responseId, session.sessionId);

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

        // Track unsubscribe function for cleanup
        let unsubscribeEvents: (() => void) | null = null;

        const finish = (err?: Error) => {
            done = true;
            error = err || null;
            // Unsubscribe from events to prevent handler accumulation
            if (unsubscribeEvents) {
                unsubscribeEvents();
                unsubscribeEvents = null;
            }
            // If there was an error, remove session from cache so a fresh one is created next time
            if (err && session) {
                this.#activeSessions.delete(session.sessionId);
            }
            if (resolveNext) {
                if (err) {
                    resolveNext = null;
                    throw err;
                }
                resolveNext({ value: undefined as any, done: true });
                resolveNext = null;
            }
        };

        // Register event handlers on the session (returns unsubscribe function)
        unsubscribeEvents = session.on((event: any) => {
            try {
                switch (event.type) {
                    case 'assistant.message_delta':
                        // Streaming text chunk
                        if (event.data?.deltaContent) {
                            const delta = extractCopilotTextDelta(
                                state.accumulated,
                                event.data.deltaContent,
                            );

                            if (delta) {
                                state.accumulated += delta;
                                pushEvent({
                                    type: 'output_text_delta',
                                    delta,
                                } as ResponseStreamEvent);
                            }
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


                            // Check if this is a user tool that requires external handling
                            // We look it up in our 'copilotTools' list
                            const isUserTool = copilotTools.some((t: any) => t.name === event.data.toolName);

                            if (isUserTool) {
                                this.#loggingService.debug('Detaching stream for user tool execution', {
                                    tool: event.data.toolName,
                                    callId: toolCall.callId,
                                });

                                // Yield the function call event to the Runner (streaming)
                                pushEvent({
                                    type: 'model',
                                    event: {
                                        type: 'function_call',
                                        callId: toolCall.callId,
                                        name: toolCall.name,
                                        arguments: toolCall.arguments,
                                    }
                                } as ResponseStreamEvent);

                                // IMPORTANT: Emit response_done so the Runner captures the responseId.
                                // This allows the next turn to pass 'previousResponseId' correctly,
                                // which we need to look up the session and resume the suspended tool.
                                const output = this.#buildStreamOutput(state);
                                pushEvent({
                                    type: 'response_done',
                                    response: {
                                        id: state.responseId,
                                        usage: normalizeUsage(state.usageData),
                                        output,
                                    },
                                } as ResponseStreamEvent);

                                // SIGNAL COMPLETION OF THIS STREAM SEGMENT
                                finish();
                                return; // Stop processing further events in this loop
                            }

                            // If it's an internal tool (like report_intent), we just let it run
                            // The SDK will call the internal handler, get the result, and continue streaming
                            // We don't emit anything to the Runner yet.
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
        // Check if we are in "Resume/Tool Output" mode
        const sessionResolutions = pendingResolutions.get(session.sessionId);
        let isResumingTool = false;

        if (sessionResolutions && sessionResolutions.size > 0) {
            // Look for tool outputs in the request input that match pending traps
            // The Runner appends the output to the history
            if (request.input && Array.isArray(request.input)) {
                for (const item of request.input) {
                    // Check for function_call_output type (mapped from SDK)
                    if (
                        (item as any).type === 'function_call_output' &&
                        (item as any).callId &&
                        sessionResolutions.has((item as any).callId)
                    ) {
                        const callId = (item as any).callId;
                        const output = (item as any).output;

                        this.#loggingService.debug('Resolving suspended tool call', {
                            callId,
                            outputLength: output?.length,
                        });

                        const resolve = sessionResolutions.get(callId)!;
                        resolve(output); // UNBLOCK the SDK handler!
                        sessionResolutions.delete(callId);
                        isResumingTool = true;
                    }
                }
            }
        }

        // Only send a new prompt if we are NOT resuming a tool call
        if (!isResumingTool) {
            try {
                // Build the prompt from the last user message
                const lastUserMessage = messages.filter(m => m.role === 'user').pop();
                const prompt = lastUserMessage?.content || '';

                if (prompt) {
                    await session.send({
                        prompt,
                    });
                } else {
                    // If no prompt and no tool resume, we might assume it's just a continue?
                    // Or maybe we should send an empty space to trigger generation?
                    // For now, assume if prompt is empty it might be an issue, but let's try sending it.
                    // Actually Copilot SDK might error on empty prompt.
                }
            } catch (err: any) {
                this.#loggingService.error('GitHubCopilot send failed', {
                    error: err.message,
                });
                yield {
                    type: 'model',
                    event: { type: 'error', message: `Failed to send message: ${err.message}` },
                } as ResponseStreamEvent;

                try {
                    await session.abort();
                } catch {
                    // Ignore abort errors
                }
                // Clean up event handler before returning
                if (unsubscribeEvents) {
                    unsubscribeEvents();
                    unsubscribeEvents = null;
                }
                // Remove session from cache on error
                this.#activeSessions.delete(session.sessionId);
                return;
            }
        }
        // If isResumingTool is true, we simply let the event loop below capture the continuation events!

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
