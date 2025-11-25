import type {OpenAIAgentClient} from '../lib/openai-agent-client.js';
import {defaultAgentClient} from '../lib/openai-agent-client.js';
import {extractCommandMessages} from '../utils/extract-command-messages.js';

interface ApprovalResult {
	type: 'approval_required';
	approval: {
		agentName: string;
		toolName: string;
		argumentsText: string;
		rawInterruption: any;
	};
}

interface ResponseResult {
	type: 'response';
	commandMessages: Array<{
		id: string;
		sender: 'command';
		command: string;
		output: string;
		success?: boolean;
	}>;
	finalText: string;
}

export type ConversationResult = ApprovalResult | ResponseResult;

const getCommandFromArgs = (args: unknown): string => {
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
		const cmdFromObject = 'command' in args ? String(args.command) : undefined;
		const argsFromObject = 'arguments' in args ? String(args.arguments) : undefined;
		return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
	}

	return String(args);
};

export class ConversationService {
	private agentClient: OpenAIAgentClient;
	private previousResponseId: string | null = null;
	private pendingApprovalContext: {state: any; interruption: any} | null = null;

	constructor({agentClient = defaultAgentClient}: {agentClient?: OpenAIAgentClient} = {}) {
		this.agentClient = agentClient;
	}

	async sendMessage(
		text: string,
		{onTextChunk}: {onTextChunk?: (fullText: string, chunk: string) => void} = {},
	): Promise<ConversationResult> {
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

	async handleApprovalDecision(answer: string): Promise<ConversationResult | null> {
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

	#buildResult(result: any, finalOutputOverride?: string): ConversationResult {
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
