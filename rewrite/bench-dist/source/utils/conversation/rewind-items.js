/**
 * Join the rendered user messages with the store's discard statistics.
 *
 * Target identity and turn numbers come from the store. The UI contributes
 * only the rendered-message boundary used to trim its projection *after* a
 * domain rewind has succeeded.
 *
 * The two lists are aligned from the newest turn backwards: the store can be
 * trimmed independently of the rendered transcript, and it is the recent turns
 * whose costs a user is deciding about. A turn with no store counterpart is not
 * selectable because the rewind operation could not resolve it authoritatively.
 */
export function buildRewindItems(userMessages, storeTargets) {
    const offset = storeTargets.length - userMessages.length;
    return userMessages.flatMap((message, position) => {
        const stats = storeTargets[position + offset];
        if (!stats)
            return [];
        return [
            {
                targetId: stats.id,
                uiIndex: message.uiIndex,
                turnNumber: stats.turnNumber,
                text: message.text,
                imageCount: stats.imageCount,
                discardedTurns: stats.discardedTurns,
                discardedReplies: stats.discardedReplies,
                discardedFiles: stats.discardedFiles,
            },
        ];
    });
}
//# sourceMappingURL=rewind-items.js.map