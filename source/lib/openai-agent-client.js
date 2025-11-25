import {run} from '@openai/agents';
import {agent} from '../agent.js';

/**
 * Minimal adapter that isolates usage of @openai/agents.
 * Swap this module to change the underlying agent provider without touching the UI.
 */
export class OpenAIAgentClient {
	async startStream(userInput, {previousResponseId} = {}) {
		return run(agent, userInput, {
			previousResponseId,
			stream: true,
		});
	}

	async continueRun(state) {
		return run(agent, state);
	}
}

export const defaultAgentClient = new OpenAIAgentClient();
