import {
	Agent,
	ModelBehaviorError,
	UserError,
	run,
	tool as createTool,
	webSearchTool,
	type Tool,
} from '@openai/agents';
import {type ModelSettingsReasoningEffort} from '@openai/agents-core/model';
import {randomUUID} from 'node:crypto';
import {DEFAULT_MODEL, getAgentDefinition} from '../agent.js';
import {loggingService} from '../services/logging-service.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	#agent: Agent;
	#reasoningEffort?: ModelSettingsReasoningEffort;
	#currentAbortController: AbortController | null = null;
	#currentCorrelationId: string | null = null;

	constructor({
		model,
		reasoningEffort,
	}: {model?: string; reasoningEffort?: ModelSettingsReasoningEffort} = {}) {
		this.#reasoningEffort = reasoningEffort;
		this.#agent = this.#createAgent({model, reasoningEffort});
		loggingService.info('OpenAI Agent Client initialized', {
			model: model || DEFAULT_MODEL,
			reasoningEffort: reasoningEffort || 'standard',
		});
	}

	setModel(model: string): void {
		this.#agent = this.#createAgent({
			model,
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
					maxTurns: 20,
					signal,
				}),
			);
			loggingService.debug('Agent stream completed successfully');
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
			run(this.#agent, state, {stream: true, maxTurns: 20, signal}),
		);
	}

	async #executeWithRetry<T>(
		operation: () => Promise<T>,
		retries = 2,
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
					errorMessage: error instanceof Error ? error.message : String(error),
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
		reasoningEffort?: ModelSettingsReasoningEffort;
	} = {}): Agent {
		const resolvedModel = model?.trim() || DEFAULT_MODEL;
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

		// Add web search tool
		if (reasoningEffort !== 'minimal') {
			tools.push(webSearchTool());
		}

		const agent = new Agent({
			name,
			model: resolvedModel,
			modelSettings: {
				reasoning: {
					effort: reasoningEffort,
					summary: 'auto',
				},
			},
			instructions,
			tools,
		});

		if (reasoningEffort) {
			(agent as any).defaultRunOptions = {
				...((agent as any).defaultRunOptions || {}),
				// Pass through to underlying client for models that support it
				reasoning: {effort: reasoningEffort},
			};
		}

		return agent;
	}
}
