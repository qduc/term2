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
import {DEFAULT_MODEL, getAgentDefinition} from '../agent.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	#agent: Agent;
	#reasoningEffort?: ModelSettingsReasoningEffort;

	constructor({
		model,
		reasoningEffort,
	}: {model?: string; reasoningEffort?: ModelSettingsReasoningEffort} = {}) {
		this.#reasoningEffort = reasoningEffort;
		this.#agent = this.#createAgent({model, reasoningEffort});
	}

	setModel(model: string): void {
		this.#agent = this.#createAgent({
			model,
			reasoningEffort: this.#reasoningEffort,
		});
	}

	async startStream(
		userInput: string,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		return this.#executeWithRetry(() =>
			run(this.#agent, userInput, {
				previousResponseId: previousResponseId ?? undefined,
				stream: true,
				maxTurns: 20,
			}),
		);
	}

	async continueRun(state: any): Promise<any> {
		return this.#executeWithRetry(() => run(this.#agent, state));
	}

	async continueRunStream(state: any): Promise<any> {
		return this.#executeWithRetry(() =>
			run(this.#agent, state, {stream: true, maxTurns: 20}),
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
