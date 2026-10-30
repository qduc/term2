export class TurnItemAccumulator {
    items = [];
    reasoningBuffer = '';
    assistantTextBuffer = '';
    displayUsage;
    flushReasoningItem() {
        if (this.reasoningBuffer) {
            this.items.push({ type: 'reasoning', text: this.reasoningBuffer });
            this.reasoningBuffer = '';
        }
    }
    flushAssistantTextItem() {
        if (this.assistantTextBuffer) {
            this.items.push({ type: 'assistant_text', text: this.assistantTextBuffer });
            this.assistantTextBuffer = '';
        }
    }
    recordToolCallItem(callId, toolName, args) {
        this.flushReasoningItem();
        this.flushAssistantTextItem();
        this.items.push({ type: 'tool_call', callId, toolName, arguments: args });
    }
    recordToolResultItem(callId, toolName, status, output) {
        this.flushReasoningItem();
        this.flushAssistantTextItem();
        this.items.push({ type: 'tool_result', callId, toolName, status, output });
    }
    resetPersistedTurnState() {
        this.items = [];
        this.reasoningBuffer = '';
        this.assistantTextBuffer = '';
        this.displayUsage = undefined;
    }
    getTurnItems() {
        return this.items;
    }
    getDisplayUsage() {
        return this.displayUsage;
    }
    setDisplayUsage(usage) {
        this.displayUsage = usage;
    }
    appendTextDelta(delta) {
        this.assistantTextBuffer += delta;
    }
    appendReasoningDelta(delta) {
        this.reasoningBuffer += delta;
    }
    hasReasoningBuffer() {
        return this.reasoningBuffer.length > 0;
    }
    hasTextBuffer() {
        return this.assistantTextBuffer.length > 0;
    }
}
//# sourceMappingURL=turn-item-accumulator.js.map