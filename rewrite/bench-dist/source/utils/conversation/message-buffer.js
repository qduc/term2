export function appendMessagesCapped(existing, additions, maxMessages) {
    if (maxMessages <= 0)
        return [];
    if (additions.length === 0 && existing.length <= maxMessages) {
        return existing.slice();
    }
    const combinedLength = existing.length + additions.length;
    if (combinedLength <= maxMessages) {
        return [...existing, ...additions];
    }
    const start = combinedLength - maxMessages;
    const trimmedExisting = existing.slice(Math.max(0, start - additions.length));
    return [...trimmedExisting, ...additions].slice(-maxMessages);
}
/**
 * Index where the trailing run of still-streaming messages begins.
 *
 * The live bot/reasoning slots keep their position in the list while they
 * stream, so anything appended during a turn lands *below* them and renders
 * under the moving text. Callers that append an already-settled row use this
 * to splice above that tail instead.
 */
export function streamingTailStart(messages) {
    let index = messages.length;
    while (index > 0) {
        const message = messages[index - 1];
        const isLiveSlot = (message.sender === 'bot' || message.sender === 'reasoning') && message.status === 'streaming';
        if (!isLiveSlot)
            break;
        index -= 1;
    }
    return index;
}
/**
 * Inserts settled messages above any live streaming tail, so their position is
 * stable: the row does not first appear at the bottom and then jump upwards
 * when the stream finalizes.
 */
export function insertBeforeStreamingTail(existing, additions, maxMessages) {
    if (additions.length === 0)
        return appendMessagesCapped(existing, [], maxMessages);
    const tailStart = streamingTailStart(existing);
    if (tailStart === existing.length)
        return appendMessagesCapped(existing, additions, maxMessages);
    const merged = [...existing.slice(0, tailStart), ...additions, ...existing.slice(tailStart)];
    return appendMessagesCapped(merged, [], maxMessages);
}
//# sourceMappingURL=message-buffer.js.map