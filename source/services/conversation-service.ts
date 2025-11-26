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

export interface CommandMessage {
	id: string;
	sender: 'command';
	command: string;
	output: string;
	success?: boolean;
}

interface ResponseResult {
	type: 'response';
	commandMessages: CommandMessage[];
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
		const argsFromObject =
			'arguments' in args ? String(args.arguments) : undefined;
		return cmdFromObject ?? argsFromObject ?? JSON.stringify(args);
	}

	return String(args);
};

export class ConversationService {
	private agentClient: OpenAIAgentClient;
	private previousResponseId: string | null = null;
	private pendingApprovalContext: {state: any; interruption: any} | null = null;

	constructor({
		agentClient = defaultAgentClient,
	}: {agentClient?: OpenAIAgentClient} = {}) {
		this.agentClient = agentClient;
	}

	reset(): void {
		this.previousResponseId = null;
		this.pendingApprovalContext = null;
	}

	async sendMessage(
		text: string,
		{
			onTextChunk,
			onCommandMessage,
		}: {
			onTextChunk?: (fullText: string, chunk: string) => void;
			onCommandMessage?: (message: CommandMessage) => void;
		} = {},
	): Promise<ConversationResult> {
		const stream = await this.agentClient.startStream(text, {
			previousResponseId: this.previousResponseId,
		});

		let finalOutput = '';
		const emittedCommandIds = new Set<string>();

		// Iterate over all stream events to capture both text chunks and command executions
		for await (const event of stream) {
			if (event.type === 'raw_model_stream_event') {
				const data = event.data;
				if (data.type === 'response.output_text.delta') {
					finalOutput += data.delta;
					onTextChunk?.(finalOutput, data.delta);
				}
			} else if (event.type === 'run_item_stream_event') {
				const item = event.item;
				// Check for completed bash tool calls
				if (
					item?.type === 'tool_call_output_item' ||
					item?.rawItem?.type === 'function_call_output'
				) {
					const commandMessages = extractCommandMessages([item]);
					for (const cmdMsg of commandMessages) {
						if (!emittedCommandIds.has(cmdMsg.id)) {
							emittedCommandIds.add(cmdMsg.id);
							onCommandMessage?.(cmdMsg);
						}
					}
				}
			}
		}

		await stream.completed;
		this.previousResponseId = stream.lastResponseId;
		// Pass emittedCommandIds so we don't duplicate commands in the final result
		return this.#buildResult(
			stream,
			finalOutput || undefined,
			emittedCommandIds,
		);
	}

	async handleApprovalDecision(
		answer: string,
		{
			onTextChunk,
			onCommandMessage,
		}: {
			onTextChunk?: (fullText: string, chunk: string) => void;
			onCommandMessage?: (message: CommandMessage) => void;
		} = {},
	): Promise<ConversationResult | null> {
		if (!this.pendingApprovalContext) {
			return null;
		}

		const {state, interruption} = this.pendingApprovalContext;
		if (answer === 'y') {
			state.approve(interruption);
		} else {
			state.reject(interruption);
		}

		const stream = await this.agentClient.continueRunStream(state);

		let finalOutput = '';
		const emittedCommandIds = new Set<string>();

		// Iterate over all stream events to capture both text chunks and command executions
		for await (const event of stream) {
			if (event.type === 'raw_model_stream_event') {
				const data = event.data;
				if (data.type === 'response.output_text.delta') {
					finalOutput += data.delta;
					onTextChunk?.(finalOutput, data.delta);
				}
			} else if (event.type === 'run_item_stream_event') {
				const item = event.item;
				// Check for completed bash tool calls
				if (
					item?.type === 'tool_call_output_item' ||
					item?.rawItem?.type === 'function_call_output'
				) {
					const commandMessages = extractCommandMessages([item]);
					for (const cmdMsg of commandMessages) {
						if (!emittedCommandIds.has(cmdMsg.id)) {
							emittedCommandIds.add(cmdMsg.id);
							onCommandMessage?.(cmdMsg);
						}
					}
				}
			}
		}

		await stream.completed;
		return this.#buildResult(
			stream,
			finalOutput || undefined,
			emittedCommandIds,
		);
	}

	#buildResult(
		result: any,
		finalOutputOverride?: string,
		emittedCommandIds?: Set<string>,
	): ConversationResult {
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

		const allCommandMessages = extractCommandMessages(
			result.newItems || result.history || [],
		);

		// Filter out commands that were already emitted in real-time
		const commandMessages = emittedCommandIds
			? allCommandMessages.filter(msg => !emittedCommandIds.has(msg.id))
			: allCommandMessages;

		return {
			type: 'response',
			commandMessages,
			finalText: finalOutputOverride ?? result.finalOutput ?? 'Done.',
		};
	}
}

export const defaultConversationService = new ConversationService();
