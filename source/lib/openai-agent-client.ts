import {
	Agent,
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
	OpenRouterError,
} from '../providers/openrouter.js';
import {OpenAICompatibleError} from '../providers/openai-compatible/api.js';
import {getProvider} from '../providers/index.js';
import {type ModelSettingsReasoningEffort} from '@openai/agents-core/model';
import {randomUUID} from 'node:crypto';
import {getAgentDefinition} from '../agent.js';
import type {ILoggingService, ISettingsService} from '../services/service-interfaces.js';
import {createEditorImpl} from './editor-impl.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	#agent: Agent;
	#model!: string;
	// Accept 'default' here to denote 'do not pass this param; use API default'
	#reasoningEffort?: ModelSettingsReasoningEffort | 'default';
	#temperature?: number;
	#provider: string;
	#maxTurns: number;
	#retryAttempts: number;
	#currentAbortController: AbortController | null = null;
	#currentCorrelationId: string | null = null;
	#retryCallback: (() => void) | null = null;
	#runner: Runner | null = null;
	#toolInterceptors: ((name: string, params: any, toolCallId?: string) => Promise<string | null>)[] = [];
    #logger: ILoggingService;
    #settings: ISettingsService;
	#editor: ReturnType<typeof createEditorImpl>;

	constructor({
		model,
		reasoningEffort,
		maxTurns,
		retryAttempts,
        deps,
	}: {
		model?: string;
		reasoningEffort?: ModelSettingsReasoningEffort | 'default';
		maxTurns?: number;
		retryAttempts?: number;
        deps: {
            logger: ILoggingService;
            settings: ISettingsService;
        };
	}) {
        this.#logger = deps.logger;
        this.#settings = deps.settings;
		this.#editor = createEditorImpl({
			loggingService: this.#logger,
			settingsService: this.#settings,
		});
		this.#reasoningEffort = reasoningEffort;
		this.#temperature = this.#settings.get<number | undefined>('agent.temperature');
		this.#provider =
			this.#settings.get<string>('agent.provider') || 'openai';
		this.#maxTurns = maxTurns ?? 20;
		this.#retryAttempts = retryAttempts ?? 2;
		this.#agent = this.#createAgent({model, reasoningEffort});
		this.#runner = this.#createRunner();
		this.#logger.info('OpenAI Agent Client initialized', {
			model: model || this.#settings.get<string>('agent.model'),
			reasoningEffort: reasoningEffort ?? 'default',
			temperature: this.#temperature,
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

	setTemperature(temperature?: number): void {
		this.#temperature = temperature;
		this.#agent = this.#createAgent({
			model: this.#model,
			reasoningEffort: this.#reasoningEffort,
			temperature,
		});
	}

	setProvider(provider: string): void {
    this.#provider = provider;
    this.#settings.set('agent.provider', provider);
    this.#agent = this.#createAgent({
        model: this.#model,
        reasoningEffort: this.#reasoningEffort,
    });
    this.#runner = this.#createRunner();
	}

	getProvider(): string {
		return this.#provider;
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
				this.#logger.error('Tool interceptor threw an error', {
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
		const providerDef = getProvider(this.#provider);
		if (!providerDef?.createRunner) {
			return null;
		}

		return providerDef.createRunner({settingsService: this.#settings, loggingService: this.#logger});
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
			this.#logger.clearCorrelationId();
			this.#currentCorrelationId = null;
		}
		this.#logger.debug('Agent operation aborted');
	}

	clearConversations(): void {
		const providerDef = getProvider(this.#provider);
		if (providerDef?.clearConversations) {
			providerDef.clearConversations();
		}
	}

	async startStream(
		userInput: string | any[],
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		// Abort any previous operation
		this.abort();

		// Create correlation ID for this stream
		this.#currentCorrelationId = randomUUID();
		this.#logger.setCorrelationId(this.#currentCorrelationId);

		this.#currentAbortController = new AbortController();
		const signal = this.#currentAbortController.signal;

		this.#logger.info('Agent stream started', {
			inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
			inputLength: typeof userInput === 'string' ? userInput.length : undefined,
			inputItems: Array.isArray(userInput) ? userInput.length : undefined,
			hasPreviousResponseId: !!previousResponseId,
		});

		try {
			const options: any = {
				stream: true,
				maxTurns: this.#maxTurns,
				signal,
			};

			// Only pass previousResponseId for OpenAI provider (server-managed conversation chaining)
			if (this.#provider === 'openai' && previousResponseId) {
				options.previousResponseId = previousResponseId;
			}

			const result = await this.#executeWithRetry(() =>
				this.#runAgent(this.#agent, userInput, options),
			);
			return result;
		} catch (error: any) {
			this.#logger.error('Agent stream failed', {
				error: error instanceof Error ? error.message : String(error),
				inputType: Array.isArray(userInput) ? 'array' : typeof userInput,
				inputLength: typeof userInput === 'string' ? userInput.length : undefined,
				inputItems: Array.isArray(userInput) ? userInput.length : undefined,
			});
			throw error;
		}
	}

	async continueRun(
		state: any,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		this.abort();
		this.#currentAbortController = new AbortController();
		const signal = this.#currentAbortController.signal;

		const options: any = {
			signal,
		};

		// Only pass previousResponseId for OpenAI provider (server-managed conversation chaining)
		if (this.#provider === 'openai' && previousResponseId) {
			options.previousResponseId = previousResponseId;
		}

		return this.#executeWithRetry(() =>
			this.#runAgent(this.#agent, state, options),
		);
	}

	async continueRunStream(
		state: any,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		this.abort();
		this.#currentAbortController = new AbortController();
		const signal = this.#currentAbortController.signal;

		const options: any = {
			stream: true,
			maxTurns: this.#maxTurns,
			signal,
		};

		// Only pass previousResponseId for OpenAI provider (server-managed conversation chaining)
		if (this.#provider === 'openai' && previousResponseId) {
			options.previousResponseId = previousResponseId;
		}

		return this.#executeWithRetry(() =>
			this.#runAgent(this.#agent, state, options),
		);
	}

	#runAgent(agent: Agent, input: any, options: any): Promise<any> {
		// Check if provider is configured but runner failed to initialize
		if (!this.#runner && this.#provider !== 'openai') {
			const providerDef = getProvider(this.#provider);
			const providerLabel = providerDef?.label || this.#provider;
			throw new Error(
				`${providerLabel} is configured but could not be initialized. ` +
				`Please check that all required credentials are set. ` +
				`For OpenRouter, set OPENROUTER_API_KEY environment variable. ` +
				`Get your API key from: https://openrouter.ai/keys`
			);
		}

		// Use runner if available (custom provider), otherwise use run() directly (OpenAI)
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
			// Determine if the error is retryable
			// UserError and ModelBehaviorError are NOT retried (logic errors, not transient)
			const isTransientError =
				error instanceof APIConnectionError ||
				error instanceof APIConnectionTimeoutError ||
				error instanceof InternalServerError ||
				error instanceof RateLimitError;

			// Check if it's an OpenRouter error with retryable status
			const isOpenRouterRetryable =
				error instanceof OpenRouterError &&
				(error.status === 429 || error.status >= 500);

			const isOpenAICompatibleRetryable =
				error instanceof OpenAICompatibleError &&
				(error.status === 429 || error.status >= 500);

			const isRetryable =
				retries > 0 &&
				(isTransientError || isOpenRouterRetryable || isOpenAICompatibleRetryable);

			if (isRetryable) {
				const attemptIndex = this.#retryAttempts - retries;
				let delay: number;

				// Check for Retry-After header (both OpenAI and OpenRouter)
				const retryAfterHeader =
					(error instanceof RateLimitError && error.headers?.['retry-after']) ||
					(error instanceof OpenRouterError && error.headers['retry-after']) ||
					(error instanceof OpenAICompatibleError &&
						error.headers['retry-after']);

				if (retryAfterHeader) {
					// Respect the Retry-After header
					delay = parseInt(retryAfterHeader, 10) * 1000;
				} else {
					// Exponential backoff with full jitter
					// Base delay: 500-1000ms
					// Multiplier: 2^attemptIndex
					// Max cap: 30 seconds
					const baseDelay = 500 + Math.random() * 500; // 500-1000ms
					const exponentialDelay = baseDelay * Math.pow(2, attemptIndex);
					const maxDelay = 30000; // 30 seconds
					const cappedDelay = Math.min(exponentialDelay, maxDelay);
					// Apply full jitter: random value between 0 and cappedDelay
					delay = Math.random() * cappedDelay;
				}

				await new Promise(resolve => setTimeout(resolve, delay));

				this.#logger.warn('Agent operation retry', {
					errorType: error.constructor.name,
					retriesRemaining: retries - 1,
					delayMs: Math.round(delay),
					attemptIndex,
					errorMessage:
						error instanceof Error ? error.message : String(error),
					...(error instanceof OpenRouterError && {status: error.status}),
					...(error instanceof OpenAICompatibleError && {status: error.status}),
				});
				this.#retryCallback?.();
				return this.#executeWithRetry(operation, retries - 1);
			}
			throw error;
		}
	}

	async chat(
		message: string,
		options: {
			model?: string;
			reasoningEffort?: ModelSettingsReasoningEffort | 'default';
		} = {},
	): Promise<string> {
		this.#logger.debug('Agent chat request', {
			messageLength: message.length,
			model: options.model || this.#model,
		});

		try {
			// Create a temporary agent for this specific chat request if params differ
			let agentForChat = this.#agent;
			if (options.model || options.reasoningEffort) {
				const tempModel = options.model || this.#model;
				const tempEffort = options.reasoningEffort || this.#reasoningEffort;
				const modelSettings: any = {};

				if (tempEffort && tempEffort !== 'default') {
					modelSettings.reasoning = {
						effort: tempEffort,
						summary: 'auto',
					};
				}

				// For simple chat, we generally don't need tools, but we keep the system instructions
				// Actually, for mentor mode, we might want a simpler agent without tools
				agentForChat = new Agent({
					name: 'Mentor',
					model: tempModel,
					...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
					instructions: 'You are a helpful mentor assistant.',
				});

				// Ensure runner is compatible or use run()
				if (!this.#runner && this.#provider !== 'openai') {
					// Logic to ensure runner exists... same as #runAgent
					const providerDef = getProvider(this.#provider);
					if (!providerDef) throw new Error(`Provider ${this.#provider} not found`);
					if (providerDef.createRunner) {
						// We can't easily reuse the main runner if it's bound to the main agent
						// But creating a new runner for every chat might be expensive?
						// For now, let's assume we can just use `run` if no tools are needed,
						// but some providers NEED a runner.
						// Actually, most providers' runners are stateless or lightweight wrappers.
					}
				}
			}

			// We use a simplified run flow for chat
			const result = await this.#runAgent(agentForChat, message, {
				stream: false,
				maxTurns: 1, // Chat is usually single turn
			});

			if (result.finalOutput) {
				return result.finalOutput;
			}

			// Fallback: extract from messages if finalOutput is missing
			if (result.messages && Array.isArray(result.messages)) {
				const lastMessage = result.messages[result.messages.length - 1];
				if (lastMessage && lastMessage.content) {
					if (typeof lastMessage.content === 'string') {
						return lastMessage.content;
					}
					if (Array.isArray(lastMessage.content)) {
						return lastMessage.content
							.map((part: any) => part.text || part.value || '')
							.join('');
					}
				}
			}

			return '';
		} catch (error) {
			this.#logger.error('Agent chat failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error; // Propagate error
		}
	}

	#createMentor = async (question: string): Promise<string> => {
		const mentorModel = this.#settings.get<string>('agent.mentorModel');
		if (!mentorModel) {
			throw new Error('Mentor model is not configured');
		}

		// Reuse this client's provider configuration but with a different model
		// We purposefully create a 'sibling' behavior here.
		// NOTE: This uses the SAME provider.

		return this.chat(question, {
			model: mentorModel,
		});
	};

	#createAgent({
		model,
		reasoningEffort,
		temperature,
	}: {
		model?: string;
		reasoningEffort?: ModelSettingsReasoningEffort | 'default';
		temperature?: number;
	} = {}): Agent {
		const resolvedModel = model?.trim() || this.#settings.get<string>('agent.model');
		this.#model = resolvedModel;
		const resolvedTemperature =
			temperature ?? this.#settings.get<number | undefined>('agent.temperature');
		const {
			name,
			instructions,
			tools: toolDefinitions,
		} = getAgentDefinition({
			settingsService: this.#settings,
			loggingService: this.#logger,
			// @ts-ignore - Definition update coming next
			askMentor: this.#createMentor,
		}, resolvedModel);

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
								this.#logger.info('Tool execution intercepted', {
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
						return definition.execute(params, _context);
					},
				}),
			);

		// Add native applyPatchTool for gpt-5.1 on OpenAI provider
		if (shouldUseNativePatchTool) {
			const nativePatchTool = applyPatchTool({
				editor: this.#editor,
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
						this.#logger.info('Native tool execution intercepted', {
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
			this.#logger.info('Using native applyPatchTool from SDK', {
				model: resolvedModel,
				provider: this.#provider,
			});
		} else {
			this.#logger.info('Using custom apply_patch implementation', {
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

		// Temperature: only pass when explicitly set (number). Undefined means
		// provider/model default.
		if (typeof resolvedTemperature === 'number' && Number.isFinite(resolvedTemperature)) {
			modelSettings.temperature = resolvedTemperature;
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
