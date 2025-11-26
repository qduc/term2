import {run, type Agent} from '@openai/agents';
import {createAgent, defaultAgent} from '../agent.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	#agent: Agent;

	constructor({agent, model}: {agent?: Agent; model?: string} = {}) {
		this.#agent = agent ?? createAgent({model});
	}

	async startStream(
		userInput: string,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		return run(this.#agent, userInput, {
			previousResponseId: previousResponseId ?? undefined,
			stream: true,
		});
	}

	async continueRun(state: any): Promise<any> {
		return run(this.#agent, state);
	}

	async continueRunStream(state: any): Promise<any> {
		return run(this.#agent, state, {stream: true});
	}
}

export const defaultAgentClient = new OpenAIAgentClient({agent: defaultAgent});
