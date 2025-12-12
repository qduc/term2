import {
	Agent,
	ModelBehaviorError,
	UserError,
	run,
	tool as createTool,
	webSearchTool,
	applyPatchTool,
	type Tool,
    Runner,
} from '@openai/agents';
import {
	APIConnectionError,
	APIConnectionTimeoutError,
	InternalServerError,
	RateLimitError,
} from 'openai';
import {
	clearOpenRouterConversations,
	OpenRouterProvider,
} from '../providers/openrouter.js';
import {type ModelSettingsReasoningEffort} from '@openai/agents-core/model';
import {randomUUID} from 'node:crypto';
import {DEFAULT_MODEL, getAgentDefinition} from '../agent.js';
import {loggingService} from '../services/logging-service.js';
import {settingsService} from '../services/settings-service.js';
import {editorImpl} from './editor-impl.js';

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
	#retryCallback: (() => void) | null = null;
	#runner: Runner | null = null;
	#toolInterceptors: ((name: string, params: any, toolCallId?: string) => Promise<string | null>)[] = [];

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
		this.#provider =
			settingsService.get<string>('agent.provider') || 'openai';
		this.#maxTurns = maxTurns ?? 20;
		this.#retryAttempts = retryAttempts ?? 2;
		this.#agent = this.#createAgent({model, reasoningEffort});
		this.#runner = this.#createRunner();
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
    settingsService.set('agent.provider', provider);
    this.#agent = this.#createAgent({
        model: this.#model,
        reasoningEffort: this.#reasoningEffort,
    });
    this.#runner = this.#createRunner();
	}

	addToolInterceptor(interceptor: (name: string, params: any, toolCallId?: string) => Promise<string | null>): () => void {
		this.#toolInterceptors.push(interceptor);
		return () => {
			this.#toolInterceptors = this.#toolInterceptors.filter(i => i !== interceptor);
		};
	}

	async #checkToolInterceptors(name: string, params: any, toolCallId?: string): Promise<string | null> {
		for (const interceptor of this.#toolInterceptors) {
			try {
				const result = await interceptor(name, params, toolCallId);
				if (result !== null) {
					return result;
				}
			} catch (error) {
				loggingService.error('Tool interceptor threw an error', {
					name,
					params,
					toolCallId,
					error: error instanceof Error ? error.message : String(error),
				});
				return `Tool execution intercepted but failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		return null;
	}

	#createRunner(): Runner | null {
		// Only create a runner if we're using OpenRouter
		if (this.#provider !== 'openrouter') {
			return null;
		}

		const apiKey = settingsService.get<string>('agent.openrouter.apiKey');
		if (!apiKey) {
			loggingService.warn(
				'OpenRouter API key not set, falling back to default provider',
			);
			return null;
		}

		return new Runner({
			modelProvider: new OpenRouterProvider(),
		});
	}

	setRetryCallback(callback: () => void): void {
		this.#retryCallback = callback;
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

	clearConversations(): void {
		if (this.#provider === 'openrouter') {
			clearOpenRouterConversations();
		}
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
				this.#runAgent(this.#agent, userInput, {
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

	async continueRun(
		state: any,
		{previousResponseId: _previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		this.abort();
		this.#currentAbortController = new AbortController();
		const signal = this.#currentAbortController.signal;

		return this.#executeWithRetry(() =>
			this.#runAgent(this.#agent, state, {
				signal,
			}),
		);
	}

	async continueRunStream(
		state: any,
		{previousResponseId: _previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		this.abort();
		this.#currentAbortController = new AbortController();
		const signal = this.#currentAbortController.signal;

		return this.#executeWithRetry(() =>
			this.#runAgent(this.#agent, state, {
				stream: true,
				maxTurns: this.#maxTurns,
				signal,
			}),
		);
	}

	#runAgent(agent: Agent, input: any, options: any): Promise<any> {
		// Use runner if available (OpenRouter), otherwise use run() directly
		if (this.#runner) {
			return this.#runner.run(agent, input, options);
		}
		return run(agent, input, options);
	}

	async #executeWithRetry<T>(
		operation: () => Promise<T>,
		retries = this.#retryAttempts,
	): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			const isRetryable =
				retries > 0 &&
				(error instanceof UserError ||
					error instanceof ModelBehaviorError ||
					error instanceof APIConnectionError ||
					error instanceof APIConnectionTimeoutError ||
					error instanceof InternalServerError ||
					error instanceof RateLimitError);

			if (isRetryable) {
				let delay = 1000 * (this.#retryAttempts - retries + 1); // Exponential backoff
				if (
					error instanceof RateLimitError &&
					error.headers?.['retry-after']
				) {
					delay = parseInt(error.headers['retry-after'], 10) * 1000;
				}
				await new Promise(resolve => setTimeout(resolve, delay));

				loggingService.warn('Agent operation retry', {
					errorType: error.constructor.name,
					retriesRemaining: retries - 1,
					delayMs: delay,
					errorMessage:
						error instanceof Error ? error.message : String(error),
				});
				this.#retryCallback?.();
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

		// Determine if we should use the native applyPatchTool
		const shouldUseNativePatchTool =
			this.#provider === 'openai' && resolvedModel.startsWith('gpt-5.1');

		const tools: Tool[] = toolDefinitions
			.filter(definition => {
				// Exclude custom apply_patch if we're using native one
				if (shouldUseNativePatchTool && definition.name === 'apply_patch') {
					return false;
				}
				return true;
			})
			.map(definition =>
				createTool({
					name: definition.name,
					description: definition.description,
					parameters: definition.parameters,
					needsApproval: async (context, params) =>
						definition.needsApproval(params, context),
					execute: async (params, _context, details) => {
							// Extract tool call ID from details if available
							const toolCallId = details?.toolCall?.callId;
							// Check if this execution should be intercepted
							const rejectionMessage = await this.#checkToolInterceptors(definition.name, params, toolCallId);
							if (rejectionMessage) {
								loggingService.info('Tool execution intercepted', {
								tool: definition.name,
								params: JSON.stringify(params).substring(0, 100),
							});
							// Return a failure response that all tools should understand
							return JSON.stringify({
								output: [{
									success: false,
									error: rejectionMessage,
								}],
							});
						}
						// Normal execution
						return definition.execute(params);
					},
				}),
			);

		// Add native applyPatchTool for gpt-5.1 on OpenAI provider
		if (shouldUseNativePatchTool) {
			const nativePatchTool = applyPatchTool({
				editor: editorImpl,
				needsApproval: false, // Default to auto-approve for now
			}) as any; // Type assertion needed as invoke is not in public API

			// Wrap the native tool's invoke function to apply interceptor check
			const originalInvoke = nativePatchTool.invoke;
			if (originalInvoke) {
				nativePatchTool.invoke = async (runContext: any, input: any, details: any) => {
					// Extract tool call ID from details if available
					const toolCallId = details?.toolCall?.callId;
					// Parse input to get params for logging
					let params: any;
					try {
						params = typeof input === 'string' ? JSON.parse(input) : input;
					} catch {
						params = input;
					}
					const rejectionMessage = await this.#checkToolInterceptors('apply_patch', params, toolCallId);
					if (rejectionMessage) {
						loggingService.info('Native tool execution intercepted', {
							tool: 'apply_patch',
							toolCallId,
							params: JSON.stringify(params).substring(0, 100),
						});
						return JSON.stringify({
							output: [{
								success: false,
								error: rejectionMessage,
							}],
						});
					}
					return originalInvoke.call(nativePatchTool, runContext, input, details);
				};
			}

			tools.push(nativePatchTool);
			loggingService.info('Using native applyPatchTool from SDK', {
				model: resolvedModel,
				provider: this.#provider,
			});
		} else {
			loggingService.info('Using custom apply_patch implementation', {
				model: resolvedModel,
				provider: this.#provider,
			});
		}

		// Add web search tool. If the user explicitly selected 'minimal' we
		// disable it; if they selected 'default', we don't influence the
		// decision and leave the web tool enabled.
		if (reasoningEffort !== 'minimal') {
			const webTool = webSearchTool();

			// Note: webSearchTool is a HostedTool that runs server-side and cannot be intercepted
			// the same way as FunctionTools. Interception for hosted tools would need to be
			// handled differently, likely through approval mechanisms.

			tools.push(webTool);
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
