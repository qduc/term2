/**
 * GitHubCopilotDirectModel - Alternative implementation that lets Copilot SDK
 * control the tool execution flow directly, without trying to integrate with
 * OpenAI Agents SDK's approval pattern.
 *
 * This is simpler and more reliable because:
 * 1. Copilot SDK handles its own event loop and tool execution
 * 2. Tools execute immediately when called (no approval required)
 * 3. We just translate events to the Agents SDK format for UI streaming
 */
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
import type {
    ILoggingService,
    ISettingsService,
} from '../../services/service-interfaces.js';
import {
    buildMessagesFromRequest,
    normalizeUsage,
} from './converters.js';
import { getAgentDefinition } from '../../agent.js';
import type { ToolDefinition } from '../../tools/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Load simple.md system prompt (same as other providers)
const SIMPLE_PROMPT_PATH = path.join(import.meta.dirname, '../../prompts/simple.md');
const SIMPLE_PROMPT = fs.readFileSync(SIMPLE_PROMPT_PATH, 'utf-8').trim();

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

    if (incoming.startsWith(accumulated)) {
        return incoming.slice(accumulated.length);
    }

    const maxOverlap = Math.min(accumulated.length, incoming.length);
    for (let len = maxOverlap; len > 0; len--) {
        const suffix = accumulated.slice(-len);
        const prefix = incoming.slice(0, len);
        if (suffix === prefix) {
            return incoming.slice(len);
        }
    }

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

/**
 * Map of tool name -> tool definition for direct execution
 */
type ToolMap = Map<string, ToolDefinition>;

export class GitHubCopilotDirectModel implements Model {
    name: string;
    #modelId: string;
    #settingsService: ISettingsService;
    #loggingService: ILoggingService;
    #sessionMap: Map<string, string>;
    #activeSessions: Map<string, CopilotSession>;
    #toolMap: ToolMap;

    constructor(deps: {
        settingsService: ISettingsService;
        loggingService: ILoggingService;
        modelId?: string;
        sessionMap?: Map<string, string>;
        activeSessions?: Map<string, CopilotSession>;
    }) {
        this.name = 'GitHubCopilotDirect';
        this.#settingsService = deps.settingsService;
        this.#loggingService = deps.loggingService;
        this.#sessionMap = deps.sessionMap || new Map();
        this.#activeSessions = deps.activeSessions || new Map();
        this.#modelId =
            deps.modelId ||
            this.#settingsService.get('agent.github-copilot.model') ||
            this.#settingsService.get('agent.model') ||
            'gpt-4o';

        // Build tool map for direct execution
        this.#toolMap = this.#buildToolMap();
    }

    #buildToolMap(): ToolMap {
        const agentDef = getAgentDefinition({
            settingsService: this.#settingsService,
            loggingService: this.#loggingService,
        }, this.#modelId);

        const toolMap = new Map<string, ToolDefinition>();
        for (const tool of agentDef.tools) {
            toolMap.set(tool.name, tool);
        }

        return toolMap;
    }

    async getResponse(request: ModelRequest): Promise<ModelResponse> {
        const events: ResponseStreamEvent[] = [];

        for await (const event of this.getStreamedResponse(request)) {
            events.push(event);
        }

        const doneEvent = events.find((e: any) => e.type === 'response_done') as any;

        if (doneEvent?.response) {
            return {
                responseId: doneEvent.response.id || randomUUID(),
                output: doneEvent.response.output || [],
                usage: normalizeUsage(doneEvent.response.usage) as any,
            };
        }

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

        this.#loggingService.debug('GitHubCopilotDirect stream start', {
            messageCount: messages.length,
            modelId: resolvedModelId,
            previousResponseId: request.previousResponseId || (request as any).providerData?.previousResponseId,
        });

        // Build direct-execution tool handlers
        const copilotTools = this.#buildCopilotToolHandlers();

        let session: CopilotSession;

        try {
            const prevResponseId = request.previousResponseId || (request as any).providerData?.previousResponseId;
            const prevSessionId = prevResponseId
                ? this.#sessionMap.get(prevResponseId)
                : undefined;

            const cachedSession = prevSessionId
                ? this.#activeSessions.get(prevSessionId)
                : undefined;

            if (cachedSession) {
                this.#loggingService.debug('Reusing cached GitHubCopilotDirect session', {
                    sessionId: prevSessionId,
                });
                session = cachedSession;
                (session as any).registerTools(copilotTools);
            } else if (prevSessionId) {
                this.#loggingService.debug('Resuming GitHubCopilotDirect session from server', {
                    sessionId: prevSessionId,
                });
                session = await client.resumeSession(prevSessionId, {
                    streaming: true,
                    tools: copilotTools,
                });
                this.#activeSessions.set(session.sessionId, session);
            } else {
                this.#loggingService.debug('Creating new GitHubCopilotDirect session');
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
                this.#activeSessions.set(session.sessionId, session);
            }
        } catch (err: any) {
            this.#loggingService.error('GitHubCopilotDirect session creation/resumption failed', {
                error: err.message,
            });
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
            toolOutputs: [] as any[],
            responseId: randomUUID(),
            usageData: null as any,
        };

        this.#sessionMap.set(state.responseId, session.sessionId);

        // Use a queue-based approach with polling to yield events
        const eventQueue: ResponseStreamEvent[] = [];
        let done = false;
        let error: Error | null = null;

        // Register event handlers
        const unsubscribe = session.on(async (event: any) => {
            try {
                switch (event.type) {
                    case 'assistant.message_delta':
                        if (event.data?.deltaContent) {
                            const delta = event.data.deltaContent;
                            state.accumulated += delta;
                            eventQueue.push({
                                type: 'output_text_delta',
                                delta,
                            } as ResponseStreamEvent);
                        }
                        break;

                    case 'assistant.reasoning_delta':
                        if (event.data?.deltaContent) {
                            state.accumulatedReasoningText += event.data.deltaContent;
                            eventQueue.push({
                                type: 'model',
                                event: {
                                    type: 'reasoning_delta',
                                    content: event.data.deltaContent,
                                },
                            } as ResponseStreamEvent);
                        }
                        break;

                    case 'tool.execution_start':
                        if (event.data) {
                            this.#loggingService.debug('GitHubCopilotDirect tool execution started', {
                                data: event.data,
                            });

                            const toolName = event.data.toolName;
                            const rawArgs = event.data.arguments || event.data.args || {};
                            const argsString = typeof rawArgs === 'string'
                                ? rawArgs
                                : JSON.stringify(rawArgs);

                            const toolCall = {
                                type: 'function_call',
                                callId: event.data.toolCallId || event.data.callId || randomUUID(),
                                name: toolName,
                                arguments: argsString,
                            };
                            state.accumulatedToolCalls.push(toolCall);

                            eventQueue.push({
                                type: 'model',
                                event: {
                                    type: 'tool_execution_start',
                                    callId: toolCall.callId,
                                    name: toolCall.name,
                                    arguments: toolCall.arguments,
                                },
                            } as ResponseStreamEvent);
                        }
                        break;

                    case 'tool.execution_complete':
                        if (event.data) {
                            this.#loggingService.debug('GitHubCopilotDirect tool execution completed', {
                                toolName: event.data.toolName,
                                callId: event.data.toolCallId,
                            });

                            eventQueue.push({
                                type: 'model',
                                event: {
                                    type: 'tool_execution_complete',
                                    callId: event.data.toolCallId || event.data.callId,
                                    name: event.data.toolName,
                                    output: event.data.result,
                                },
                            } as ResponseStreamEvent);

                            state.toolOutputs.push({
                                callId: event.data.toolCallId || event.data.callId,
                                name: event.data.toolName,
                                output: event.data.result,
                            });
                        }
                        break;

                    case 'session.usage':
                    case 'assistant.usage':
                        if (event.data) {
                            state.usageData = event.data;
                        }
                        break;

                    case 'session.idle':
                        this.#loggingService.debug('GitHubCopilotDirect stream done', {
                            text: state.accumulated,
                            toolCalls: state.accumulatedToolCalls.length,
                        });

                        const output = this.#buildStreamOutput(state);
                        eventQueue.push({
                            type: 'response_done',
                            response: {
                                id: state.responseId,
                                usage: normalizeUsage(state.usageData),
                                output,
                            },
                        } as ResponseStreamEvent);

                        done = true;
                        break;

                    case 'session.error':
                        this.#loggingService.error('GitHubCopilotDirect session error', {
                            error: event.data?.message,
                        });
                        eventQueue.push({
                            type: 'model',
                            event: { type: 'error', message: event.data?.message || 'Unknown error' },
                        } as ResponseStreamEvent);
                        error = new Error(event.data?.message || 'Session error');
                        done = true;
                        break;
                }
            } catch (err: any) {
                this.#loggingService.error('GitHubCopilotDirect event processing error', {
                    error: err.message,
                    eventType: event.type,
                });
            }
        });

        // Send the user message
        try {
            const lastUserMessage = messages.filter(m => m.role === 'user').pop();
            const prompt = lastUserMessage?.content || '';

            if (prompt) {
                await session.send({ prompt });
            }
        } catch (err: any) {
            this.#loggingService.error('GitHubCopilotDirect send failed', {
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
            unsubscribe();
            this.#activeSessions.delete(session.sessionId);
            return;
        }

        // Poll for events until done (with timeout)
        const timeout = 300000; // 5 minute timeout
        const startTime = Date.now();

        while (!done && (Date.now() - startTime) < timeout) {
            // Yield any queued events
            while (eventQueue.length > 0) {
                yield eventQueue.shift()!;
            }

            // Small delay to prevent tight loop
            await new Promise(r => setTimeout(r, 10));
        }

        // Yield remaining events
        while (eventQueue.length > 0) {
            yield eventQueue.shift()!;
        }

        unsubscribe();

        if (error) {
            throw error;
        }

        if (!done) {
            this.#loggingService.warn('GitHubCopilotDirect stream timeout');
            yield {
                type: 'model',
                event: { type: 'error', message: 'Stream timeout' },
            } as ResponseStreamEvent;
        }
    }

    /**
     * Build tool handlers that execute directly (no approval workflow)
     */
    #buildCopilotToolHandlers(): any[] {
        const handlers: any[] = [];

        for (const [name, toolDef] of this.#toolMap) {
            // Convert Zod schema to JSON Schema
            const jsonSchema = zodToJsonSchema(toolDef.parameters as any, {
                target: 'jsonSchema7',
            });

            handlers.push({
                name,
                description: toolDef.description,
                parameters: jsonSchema,
                handler: async (args: any, invocation: any) => {
                    this.#loggingService.debug('Executing tool directly', {
                        tool: name,
                        callId: invocation.toolCallId,
                        args,
                    });

                    try {
                        // Execute the tool directly
                        const result = await toolDef.execute(args);

                        this.#loggingService.debug('Tool execution completed', {
                            tool: name,
                            callId: invocation.toolCallId,
                            resultLength: typeof result === 'string' ? result.length : undefined,
                        });

                        return result;
                    } catch (err: any) {
                        this.#loggingService.error('Tool execution failed', {
                            tool: name,
                            callId: invocation.toolCallId,
                            error: err.message,
                        });
                        return `Error executing ${name}: ${err.message}`;
                    }
                },
            });
        }

        return handlers;
    }

    #buildStreamOutput(state: {
        accumulated: string;
        accumulatedReasoningText: string;
        accumulatedToolCalls: any[];
        toolOutputs: any[];
    }): any[] {
        const output: any[] = [];

        // Add tool calls with their outputs
        for (const toolCall of state.accumulatedToolCalls) {
            const toolOutput = state.toolOutputs.find(o => o.callId === toolCall.callId);

            output.push({
                type: 'function_call',
                callId: toolCall.callId,
                name: toolCall.name,
                arguments: toolCall.arguments,
                status: 'completed',
            });

            if (toolOutput) {
                output.push({
                    type: 'function_call_output',
                    callId: toolCall.callId,
                    output: toolOutput.output,
                });
            }
        }

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

        return output;
    }

    #resolveModelFromRequest(req: ModelRequest): string | undefined {
        if ((req as any)?.providerData?.model) {
            return (req as any).providerData.model;
        }
        return undefined;
    }
}
