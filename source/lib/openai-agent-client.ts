import {
	Agent,
	ModelBehaviorError,
	UserError,
	run,
	tool as createTool,
} from '@openai/agents';
import {DEFAULT_MODEL, getAgentDefinition} from '../agent.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	#agent: Agent;

	constructor({model}: {model?: string} = {}) {
		this.#agent = this.#createAgent({model});
	}

	async startStream(
		userInput: string,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		return this.#executeWithRetry(() =>
			run(this.#agent, userInput, {
				previousResponseId: previousResponseId ?? undefined,
				stream: true,
			}),
		);
	}

	async continueRun(state: any): Promise<any> {
		return this.#executeWithRetry(() => run(this.#agent, state));
	}

	async continueRunStream(state: any): Promise<any> {
		return this.#executeWithRetry(() =>
			run(this.#agent, state, { stream: true }),
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
				(error instanceof UserError || error instanceof ModelBehaviorError)
			) {
				return this.#executeWithRetry(operation, retries - 1);
			}
			throw error;
		}
	}

	#createAgent({model}: {model?: string} = {}): Agent {
		const {name, instructions, tools: toolDefinitions} = getAgentDefinition();
		const resolvedModel = model?.trim() || DEFAULT_MODEL;

		const tools = toolDefinitions.map(definition =>
			createTool({
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				needsApproval: async (context, params) =>
					definition.needsApproval(params, context),
				execute: async params => definition.execute(params),
			}),
		);

		return new Agent({
			name,
			model: resolvedModel,
			instructions,
			tools,
		});
	}
}

export const defaultAgentClient = new OpenAIAgentClient();
