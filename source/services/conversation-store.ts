import type {AgentInputItem} from '@openai/agents';

/**
 * ConversationStore maintains the canonical conversation history for the app.
 *
 * The Agents SDK can accept either a string (single new user input) or an
 * AgentInputItem[] (full conversation history). For providers without
 * server-managed conversation chaining (e.g. OpenRouter), we must provide the
 * full history on each turn.
 */
export class ConversationStore {
	#history: AgentInputItem[] = [];

	addUserMessage(text: string): void {
		const trimmed = text ?? '';
		const item: AgentInputItem = {
			role: 'user',
			type: 'message',
			content: trimmed,
		};
		this.#history.push(item);
	}

	updateFromResult(result: any): void {
		const incoming = result?.history;
		if (!Array.isArray(incoming) || incoming.length === 0) {
			return;
		}

		const next = this.#cloneHistory(incoming as AgentInputItem[]);

		if (this.#history.length === 0) {
			this.#history = next;
			return;
		}

		// If the incoming history looks like a full transcript (superset), prefer it.
		if (next.length >= this.#history.length) {
			const isSuperset = this.#isPrefixMatch(this.#history, next);
			if (isSuperset) {
				this.#history = next;
				return;
			}
		}

		// Otherwise, merge by detecting any overlap between the end of the existing
		// history and the beginning of the incoming history.
		const overlap = this.#findSuffixPrefixOverlap(this.#history, next);
		if (overlap > 0) {
			// Preserve richer incoming items (e.g. assistant reasoning_details) for the
			// overlapped region. This is important because overlap detection uses a
			// signature that intentionally ignores many fields.
			const mergedExisting = this.#cloneHistory(this.#history);
			for (let i = 0; i < overlap; i++) {
				const existingIndex = mergedExisting.length - overlap + i;
				mergedExisting[existingIndex] = this.#preferIncomingItem(
					mergedExisting[existingIndex],
					next[i],
				);
			}
			this.#history = [...mergedExisting, ...next.slice(overlap)];
			return;
		}

		this.#history = [...this.#history, ...next];
	}

	getHistory(): AgentInputItem[] {
		return this.#cloneHistory(this.#history);
	}

	getLastUserMessage(): string {
		for (let i = this.#history.length - 1; i >= 0; i--) {
			const item: any = this.#history[i];
			const raw = item?.rawItem ?? item;
			if (raw?.role !== 'user') {
				continue;
			}

			const content = raw?.content;
			if (typeof content === 'string') {
				return content;
			}
			if (Array.isArray(content)) {
				return content
					.filter((c: any) =>
						(c?.type === 'input_text' || c?.type === 'output_text') &&
						typeof c?.text === 'string',
					)
					.map((c: any) => c.text)
					.join('');
			}

			return '';
		}

		return '';
	}

	clear(): void {
		this.#history = [];
	}

	/**
	 * Remove the last user message from history.
	 * Used when retrying after a tool hallucination error.
	 */
	removeLastUserMessage(): void {
		for (let i = this.#history.length - 1; i >= 0; i--) {
			const item: any = this.#history[i];
			const raw = item?.rawItem ?? item;
			if (raw?.role === 'user') {
				this.#history.splice(i, 1);
				return;
			}
		}
	}

	#cloneHistory(items: AgentInputItem[]): AgentInputItem[] {
		// Avoid leaking references to external callers.
		// structuredClone is available in modern Node; fall back to a shallow copy.
		try {
			return structuredClone(items);
		} catch {
			return items.slice();
		}
	}

	#preferIncomingItem(
		existing: AgentInputItem,
		incoming: AgentInputItem,
	): AgentInputItem {
		const eAny: any = existing as any;
		const iAny: any = incoming as any;
		const eRaw: any = eAny?.rawItem ?? eAny;
		const iRaw: any = iAny?.rawItem ?? iAny;

		// Prefer the incoming item if it provides reasoning_details/tool_calls that
		// the existing overlapped item doesn't have.
		const isAssistantMessage =
			iRaw?.role === 'assistant' &&
			iRaw?.type === 'message' &&
			eRaw?.role === 'assistant' &&
			eRaw?.type === 'message';

		if (isAssistantMessage) {
			const incomingReasoning =
				iAny?.reasoning_details ?? iRaw?.reasoning_details;
			const existingReasoning =
				eAny?.reasoning_details ?? eRaw?.reasoning_details;
			if (existingReasoning == null && incomingReasoning != null) {
				return incoming;
			}

			// Preserve OpenRouter "reasoning" (reasoning tokens) field as well.
			const incomingReasoningText = iAny?.reasoning ?? iRaw?.reasoning;
			const existingReasoningText = eAny?.reasoning ?? eRaw?.reasoning;
			if (existingReasoningText == null && incomingReasoningText != null) {
				return incoming;
			}

			const incomingToolCalls = iAny?.tool_calls ?? iRaw?.tool_calls;
			const existingToolCalls = eAny?.tool_calls ?? eRaw?.tool_calls;
			if (existingToolCalls == null && incomingToolCalls != null) {
				return incoming;
			}
		}

		return existing;
	}

	#signature(item: AgentInputItem): string {
		const anyItem: any = item as any;
		const raw = anyItem?.rawItem ?? anyItem;

		// Prefer stable IDs when present.
		if (typeof raw?.id === 'string' && raw.id) {
			return `id:${raw.id}`;
		}

		// Tool calls / outputs tend to have call IDs.
		const callId = raw?.callId ?? raw?.call_id ?? raw?.tool_call_id;
		if (typeof callId === 'string' && callId) {
			return `call:${callId}:${raw?.type ?? ''}`;
		}

		// Message-like items: role + content text.
		const role = typeof raw?.role === 'string' ? raw.role : '';
		const type = typeof raw?.type === 'string' ? raw.type : '';
		let text = '';
		const content = raw?.content;
		if (typeof content === 'string') {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((c: any) => typeof c?.text === 'string')
				.map((c: any) => c.text)
				.join('');
		}

		if (role) {
			return `msg:${role}:${type}:${text}`;
		}

		// Fallback: type + name if present.
		const name = typeof raw?.name === 'string' ? raw.name : '';
		return `item:${type}:${name}`;
	}

	#isPrefixMatch(prefix: AgentInputItem[], full: AgentInputItem[]): boolean {
		if (prefix.length > full.length) {
			return false;
		}

		for (let i = 0; i < prefix.length; i++) {
			if (this.#signature(prefix[i]) !== this.#signature(full[i])) {
				return false;
			}
		}

		return true;
	}

	#findSuffixPrefixOverlap(
		existing: AgentInputItem[],
		incoming: AgentInputItem[],
	): number {
		const maxWindow = 50;
		const maxOverlap = Math.min(existing.length, incoming.length, maxWindow);

		for (let k = maxOverlap; k >= 1; k--) {
			let matches = true;
			for (let i = 0; i < k; i++) {
				const a = existing[existing.length - k + i];
				const b = incoming[i];
				if (this.#signature(a) !== this.#signature(b)) {
					matches = false;
					break;
				}
			}
			if (matches) {
				return k;
			}
		}

		return 0;
	}
}
