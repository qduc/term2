let nextId = 0;
const itemId = () => `item_${Date.now().toString(36)}_${(nextId++).toString(36)}`;
function lastUserText(input) {
    for (let index = input.length - 1; index >= 0; index -= 1) {
        const item = input[index];
        if (item.type === 'user_message') {
            return item.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
        }
    }
    return '';
}
/**
 * A deterministic stand-in for a provider. After a tool result it summarises
 * the result; otherwise "read <name>" or "write <name>: <text>" in the latest
 * user message becomes a tool call, and anything else is echoed back.
 */
export function scriptedModel(ref = { provider: 'scripted', model: 'tracer' }) {
    return {
        ref,
        contextWindow: 100_000,
        async *stream(request) {
            const last = request.input.at(-1);
            if (last?.type === 'tool_result') {
                const text = last.isError ? `The tool failed: ${last.output}` : `Done. Tool said: ${last.output}`;
                yield { type: 'text_delta', delta: text };
                yield { type: 'item', item: { type: 'assistant_message', id: itemId(), content: [{ type: 'text', text }] } };
                yield { type: 'done', stopReason: 'end_turn' };
                return;
            }
            const prompt = lastUserText(request.input).trim();
            const read = /^read (\S+)$/.exec(prompt);
            const write = /^write (\S+): (.+)$/.exec(prompt);
            if (read || write) {
                const callId = `call_${itemId()}`;
                const item = read
                    ? { type: 'tool_call', id: itemId(), callId, toolName: 'read_note', input: { name: read[1] } }
                    : {
                        type: 'tool_call',
                        id: itemId(),
                        callId,
                        toolName: 'write_note',
                        input: { name: write[1], text: write[2] },
                    };
                yield { type: 'item', item };
                yield { type: 'done', stopReason: 'tool_use' };
                return;
            }
            const text = `You said: ${prompt}`;
            yield { type: 'text_delta', delta: text };
            yield { type: 'item', item: { type: 'assistant_message', id: itemId(), content: [{ type: 'text', text }] } };
            yield { type: 'done', stopReason: 'end_turn' };
        },
    };
}
export function singleModelRegistry(model) {
    return {
        resolve: () => model,
        list: () => [model.ref],
    };
}
//# sourceMappingURL=scripted.js.map