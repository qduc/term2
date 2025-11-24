const BASH_TOOL_NAME = 'bash';

const coerceToText = value => {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'string') {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map(part => coerceToText(part)).filter(Boolean).join('\n');
	}

	if (typeof value === 'object') {
		if (typeof value.text === 'string') {
			return value.text;
		}

		if (typeof value.output === 'string') {
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

const getOutputText = item => {
	const rawItem = item?.rawItem ?? item;
	const candidates = [
		item?.output,
		rawItem?.output,
		item?.output?.text,
		rawItem?.output?.text,
	];

	for (const candidate of candidates) {
		const asText = coerceToText(candidate);
		if (asText) {
			return asText;
		}
	}

	return '';
};

const safeJsonParse = payload => {
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

const normalizeToolItem = item => {
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

export const extractCommandMessages = (items = []) => {
	return (items ?? [])
		.map((item, index) => {
			const normalizedItem = normalizeToolItem(item);
			if (!normalizedItem || normalizedItem.toolName !== BASH_TOOL_NAME) {
				return null;
			}

			const parsedOutput = safeJsonParse(normalizedItem.outputText);
			const command =
				parsedOutput?.command ??
				parsedOutput?.arguments ??
				normalizedItem.arguments ??
				'Unknown command';
			const output =
				parsedOutput?.output ?? normalizedItem.outputText ?? 'No output available';
			const success = parsedOutput?.success;

			return {
				id: `${Date.now()}-${index}`,
				sender: 'command',
				command,
				output,
				success,
			};
		})
		.filter(Boolean);
};
