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

	setModel(model: string): void {
		this.agentClient.setModel(model);
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

		const {finalOutput, emittedCommandIds} = await this.#consumeStream(stream, {
			onTextChunk,
			onCommandMessage,
		});
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

		const {finalOutput, emittedCommandIds} = await this.#consumeStream(stream, {
			onTextChunk,
			onCommandMessage,
		});
		return this.#buildResult(
			stream,
			finalOutput || undefined,
			emittedCommandIds,
		);
	}

	async #consumeStream(
		stream: any,
		{
			onTextChunk,
			onCommandMessage,
		}: {
			onTextChunk?: (fullText: string, chunk: string) => void;
			onCommandMessage?: (message: CommandMessage) => void;
		} = {},
	): Promise<{finalOutput: string; emittedCommandIds: Set<string>}> {
		let finalOutput = '';
		const emittedCommandIds = new Set<string>();

		const emitText = (delta: string) => {
			if (!delta) {
				return;
			}

			finalOutput += delta;
			onTextChunk?.(finalOutput, delta);
		};

		for await (const event of stream) {
			this.#emitTextDelta(event, emitText);
			if (event?.data) {
				this.#emitTextDelta(event.data, emitText);
			}

			if (event?.type === 'run_item_stream_event') {
				this.#emitCommandMessages(
					[event.item],
					emittedCommandIds,
					onCommandMessage,
				);
			} else if (
				event?.type === 'tool_call_output_item' ||
				event?.rawItem?.type === 'function_call_output'
			) {
				this.#emitCommandMessages([event], emittedCommandIds, onCommandMessage);
			}
		}

		await stream.completed;
		return {finalOutput, emittedCommandIds};
	}

	#emitCommandMessages(
		items: any[] = [],
		emittedCommandIds: Set<string>,
		onCommandMessage?: (message: CommandMessage) => void,
	): void {
		if (!items?.length || !onCommandMessage) {
			return;
		}

		const commandMessages = extractCommandMessages(items);
		for (const cmdMsg of commandMessages) {
			if (emittedCommandIds.has(cmdMsg.id)) {
				continue;
			}

			emittedCommandIds.add(cmdMsg.id);
			onCommandMessage(cmdMsg);
		}
	}

	#emitTextDelta(payload: any, emitText: (delta: string) => void): boolean {
		const deltaText = this.#extractTextDelta(payload);
		if (!deltaText) {
			return false;
		}

		emitText(deltaText);
		return true;
	}

	#extractTextDelta(payload: any): string | null {
		if (payload === null || payload === undefined) {
			return null;
		}

		if (typeof payload === 'string') {
			return payload || null;
		}

		if (typeof payload !== 'object') {
			return null;
		}

		const type = typeof (payload as any).type === 'string' ? payload.type : '';
		const looksLikeOutput =
			typeof type === 'string' && type.includes('output_text');
		const hasOutputProperties = Boolean(
			(payload as any).delta ??
				(payload as any).output_text ??
				(payload as any).text ??
				(payload as any).content,
		);

		if (!looksLikeOutput && !hasOutputProperties) {
			return null;
		}

		const deltaCandidate =
			(payload as any).delta ??
			(payload as any).output_text ??
			(payload as any).text ??
			(payload as any).content;
		const text = this.#coerceToText(deltaCandidate);
		return text || null;
	}

	#coerceToText(value: unknown): string {
		if (value === null || value === undefined) {
			return '';
		}

		if (typeof value === 'string') {
			return value;
		}

		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}

		if (Array.isArray(value)) {
			return value
				.map(entry => this.#coerceToText(entry))
				.filter(Boolean)
				.join('');
		}

		if (typeof value === 'object') {
			const record = value as Record<string, unknown>;
			const candidates = ['text', 'value', 'content', 'delta'];
			for (const field of candidates) {
				if (field in record) {
					const text = this.#coerceToText(record[field]);
					if (text) {
						return text;
					}
				}
			}
		}

		return '';
	}

	#buildResult(
		result: any,
		finalOutputOverride?: string,
		emittedCommandIds?: Set<string>,
	): ConversationResult {
		if (result.interruptions && result.interruptions.length > 0) {
			const interruption = result.interruptions[0];
			this.pendingApprovalContext = {state: result.state, interruption};

			let argumentsText = '';
			let toolName = interruption.name;

			if (interruption.type === 'shell_call') {
				toolName = 'shell';
				if (interruption.action?.commands) {
					argumentsText = Array.isArray(interruption.action.commands)
						? interruption.action.commands.join('\n')
						: String(interruption.action.commands);
				}
			} else {
				argumentsText = getCommandFromArgs(interruption.arguments);
			}

			return {
				type: 'approval_required',
				approval: {
					agentName: interruption.agent?.name ?? 'Agent',
					toolName: toolName ?? 'Unknown Tool',
					argumentsText,
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
