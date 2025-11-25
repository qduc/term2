import {defaultAgentClient} from '../lib/openai-agent-client.js';
import {extractCommandMessages} from '../utils/extract-command-messages.js';

const getCommandFromArgs = args => {
	if (!args) {
		return '';
	}

	if (typeof args === 'string') {
		try {
			const parsed = JSON.parse(args);
			return parsed?.command ?? args;
		} catch {
			return args;
		}
	}

	if (typeof args === 'object') {
		return args.command ?? args.arguments ?? JSON.stringify(args);
	}

	return String(args);
};

export class ConversationService {
	constructor({agentClient = defaultAgentClient} = {}) {
		this.agentClient = agentClient;
		this.previousResponseId = null;
		this.pendingApprovalContext = null;
	}

	async sendMessage(text, {onTextChunk} = {}) {
		const stream = await this.agentClient.startStream(text, {
			previousResponseId: this.previousResponseId,
		});

		let finalOutput = '';
		const textStream = stream.toTextStream();
		for await (const chunk of textStream) {
			finalOutput += chunk;
			onTextChunk?.(finalOutput, chunk);
		}

		await stream.completed;
		this.previousResponseId = stream.lastResponseId;
		return this.#buildResult(stream, finalOutput || undefined);
	}

	async handleApprovalDecision(answer) {
		if (!this.pendingApprovalContext) {
			return null;
		}

		const {state, interruption} = this.pendingApprovalContext;
		if (answer === 'y') {
			state.approve(interruption);
		} else {
			state.reject(interruption);
		}

		const nextResult = await this.agentClient.continueRun(state);
		return this.#buildResult(nextResult);
	}

	#buildResult(result, finalOutputOverride) {
		if (result.interruptions && result.interruptions.length > 0) {
			const interruption = result.interruptions[0];
			this.pendingApprovalContext = {state: result.state, interruption};

			return {
				type: 'approval_required',
				approval: {
					agentName: interruption.agent?.name ?? 'Agent',
					toolName: interruption.name,
					argumentsText: getCommandFromArgs(interruption.arguments),
					rawInterruption: interruption,
				},
			};
		}

		this.pendingApprovalContext = null;

		const commandMessages = extractCommandMessages(
			result.newItems || result.history || [],
		);

		return {
			type: 'response',
			commandMessages,
			finalText: finalOutputOverride ?? result.finalOutput ?? 'Done.',
		};
	}
}

export const defaultConversationService = new ConversationService();
