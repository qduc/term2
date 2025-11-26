const BASH_TOOL_NAME = 'bash';

interface CommandMessage {
	id: string;
	sender: 'command';
	command: string;
	output: string;
	success?: boolean;
}

const coerceToText = (value: unknown): string => {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'string') {
		return value;
	}

	if (Array.isArray(value)) {
		return value
			.map(part => coerceToText(part))
			.filter(Boolean)
			.join('\n');
	}

	if (typeof value === 'object') {
		if ('text' in value && typeof value.text === 'string') {
			return value.text;
		}

		if ('output' in value && typeof value.output === 'string') {
			return value.output;
		}

		try {
			return JSON.stringify(value);
		} catch {
			return '';
		}
	}

	return String(value);
};

const getOutputText = (item: any): string => {
	const sources = [item, item?.rawItem];

	for (const source of sources) {
		if (!source) {
			continue;
		}

		for (const candidate of [source.output, source.output?.text]) {
			const text = coerceToText(candidate);
			if (text) {
				return text;
			}
		}
	}

	return '';
};

const safeJsonParse = (payload: unknown): any => {
	if (typeof payload !== 'string') {
		return null;
	}

	const trimmed = payload.trim();
	if (!trimmed) {
		return null;
	}

	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
};

const normalizeToolItem = (
	item: any,
): {toolName: string; arguments: any; outputText: string} | null => {
	if (!item) {
		return null;
	}

	const rawItem = item.rawItem ?? item;
	const type = item.type ?? rawItem?.type;
	const isFunctionResult =
		type === 'function_call_result' || rawItem?.type === 'function_call_result';
	const isToolCallOutput = type === 'tool_call_output_item';

	if (!isFunctionResult && !isToolCallOutput) {
		return null;
	}

	const toolName = rawItem?.name ?? item.name;
	if (!toolName) {
		return null;
	}

	return {
		toolName,
		arguments: rawItem?.arguments ?? item.arguments,
		outputText: getOutputText(item),
	};
};

export const extractCommandMessages = (items: any[] = []): CommandMessage[] => {
	const messages: CommandMessage[] = [];

	for (const [index, item] of (items ?? []).entries()) {
		const normalizedItem = normalizeToolItem(item);
		if (!normalizedItem || normalizedItem.toolName !== BASH_TOOL_NAME) {
			continue;
		}

		const parsedOutput = safeJsonParse(normalizedItem.outputText);
		const commandSource =
			parsedOutput?.command ??
			parsedOutput?.arguments ??
			normalizedItem.arguments ??
			'Unknown command';
		const command = coerceToText(commandSource) || 'Unknown command';
		const stdoutText = coerceToText(parsedOutput?.stdout);
		const stderrText = coerceToText(parsedOutput?.stderr);
		const defaultOutput =
			parsedOutput?.output ??
			normalizedItem.outputText ??
			'No output available';
		const combinedStdOutput = [stdoutText, stderrText]
			.filter(Boolean)
			.join('\n');
		const output = combinedStdOutput || defaultOutput;
		const success = parsedOutput?.success;

		// Use a stable ID based on the item's id/callId, or fall back to timestamp
		const rawItem = item?.rawItem ?? item;
		const stableId =
			rawItem?.id ??
			rawItem?.callId ??
			item?.id ??
			item?.callId ??
			`${Date.now()}-${index}`;

		messages.push({
			id: stableId,
			sender: 'command',
			command,
			output,
			success,
		});
	}

	return messages;
};
