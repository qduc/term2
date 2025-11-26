import {run} from '@openai/agents';
import {agent} from '../agent.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	async startStream(
		userInput: string,
		{previousResponseId}: {previousResponseId?: string | null} = {},
	): Promise<any> {
		return run(agent, userInput, {
			previousResponseId: previousResponseId ?? undefined,
			stream: true,
		});
	}

	async continueRun(state: any): Promise<any> {
		return run(agent, state);
	}

	async continueRunStream(state: any): Promise<any> {
		return run(agent, state, {stream: true});
	}
}

export const defaultAgentClient = new OpenAIAgentClient();
