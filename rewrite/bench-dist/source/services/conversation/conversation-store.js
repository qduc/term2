import { normalizeUserTurn } from '../../types/user-turn.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_CREATE_FILE, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';
import { projectConversationMessage } from './conversation-message-projection.js';
import { normalizeRunItem } from './run-item-normalizer.js';
export { SHELL_CONTEXT_PREFIX } from './conversation-message-projection.js';
/**
 * Tools whose calls mutate files on disk. Rewinding does not revert these edits,
 * so the picker names them to show what the conversation will stop accounting for.
 */
const FILE_MUTATING_TOOLS = new Set([TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE, TOOL_NAME_CREATE_FILE]);
/**
 * ConversationStore maintains the live provider-facing transcript projection.
 *
 * The application turn boundary accepts either a string (single new user
 * input) or a full conversation history. For providers without server-managed
 * conversation chaining (e.g. OpenRouter), we must provide the full history
 * on each turn.
 *
 * This store does not own the complete durable conversation state. Tool
 * lifecycle recovery, assistant journal replay, and cross-stream precedence
 * rules belong to conversation-state-projector.
 */
export class ConversationStore {
    #history = [];
    #historyRevision = 0;
    #historyIdentity = crypto.randomUUID();
    addUserTurn(input) {
        const turn = normalizeUserTurn(input);
        const images = turn.images ?? [];
        const text = turn.text ?? '';
        if (images.length === 0) {
            this.addUserMessage(text);
            return;
        }
        const content = [];
        if (text) {
            content.push({ type: 'input_text', text });
        }
        for (const image of images) {
            content.push({
                type: 'input_image',
                image: `data:${image.mimeType};base64,${image.data}`,
                detail: 'auto',
            });
        }
        const item = {
            role: 'user',
            type: 'message',
            content,
        };
        this.#history.push(item);
        this.#historyRevision++;
    }
    addUserMessage(text) {
        const trimmed = text ?? '';
        const item = {
            role: 'user',
            type: 'message',
            content: trimmed,
        };
        this.#history.push(item);
        this.#historyRevision++;
    }
    /**
     * Add an item that was deserialized from a saved conversation.
     * Unlike addUserMessage, this preserves the original item structure
     * (role, type, content, callId, etc.) so that tool calls, function results,
     * and other non-user items are restored faithfully.
     */
    addImportedItem(item) {
        this.#history.push(item);
        this.#historyRevision++;
    }
    addShellContext(historyText) {
        const trimmed = historyText ?? '';
        if (!trimmed.trim()) {
            return;
        }
        const item = {
            role: 'user',
            type: 'message',
            content: trimmed,
        };
        this.#history.push(item);
        this.#historyRevision++;
    }
    /**
     * Append newly-generated items to the store. Use when the input was a delta
     * (conversation-chaining) — the store already contains the user turn(s).
     */
    appendOutput(items) {
        if (!Array.isArray(items) || items.length === 0)
            return;
        this.#history.push(...this.#cloneHistory(items));
        this.#historyRevision++;
    }
    /**
     * Overwrite the store with a full transcript. Use when the input was
     * full-history — the inherited transport returns the authoritative
     * conversation.
     */
    replaceHistory(items) {
        if (!Array.isArray(items) || items.length === 0)
            return;
        this.#history = this.#cloneHistory(items);
        this.#historyRevision++;
    }
    /** Atomically replace history only if no transcript mutation raced the caller. */
    replaceHistoryAtRevision(expectedRevision, items) {
        if (this.#historyRevision !== expectedRevision)
            return false;
        this.#history = this.#cloneHistory([...items]);
        this.#historyRevision++;
        return true;
    }
    getHistory() {
        return this.#cloneHistory(this.#history);
    }
    /**
     * Cheap revision/identity for the provider-facing transcript. Does not clone
     * history — use this when only the cache key / prefix anchor is needed.
     */
    getProviderHistoryIdentity() {
        const origin = `history:${this.#historyIdentity}`;
        return {
            revision: this.#historyRevision,
            identity: `${origin}:${this.#historyRevision}`,
            origin,
        };
    }
    /**
     * Returns a read-only copy of the complete provider-facing transcript. The
     * revision/identity pair is the prefix anchor for provider-private
     * continuation instrumentation; callers cannot mutate the store through it.
     */
    getProviderHistorySnapshot() {
        const { revision, identity, origin } = this.getProviderHistoryIdentity();
        const history = this.#freezeHistory(this.#cloneSnapshotHistory(this.#history));
        return Object.freeze({
            revision,
            identity,
            origin,
            history,
        });
    }
    getLastUserMessage() {
        for (let i = this.#history.length - 1; i >= 0; i--) {
            const message = projectConversationMessage(this.#history[i]);
            if (message?.role === 'user')
                return message.text;
        }
        return '';
    }
    clear() {
        this.#history = [];
        this.#historyRevision++;
    }
    /**
     * Remove the last user message from history.
     * Used when retrying after a tool hallucination error.
     */
    removeLastUserMessage() {
        for (let i = this.#history.length - 1; i >= 0; i--) {
            if (projectConversationMessage(this.#history[i])?.role === 'user') {
                this.#history.splice(i, 1);
                this.#historyRevision++;
                return;
            }
        }
    }
    peekLastToolOutput() {
        const anchor = this.#findLastToolOutputIndex();
        if (anchor === -1)
            return null;
        return ConversationStore.#extractRemovedToolOutput(this.#history[anchor], anchor);
    }
    /**
     * Remove everything after the last tool output while keeping that tool
     * output itself in the transcript so the model can retry from there.
     */
    removeAfterLastToolOutput() {
        const anchor = this.#findLastToolOutputIndex();
        if (anchor === -1)
            return null;
        const removed = ConversationStore.#extractRemovedToolOutput(this.#history[anchor], anchor);
        this.#history.splice(anchor + 1);
        this.#historyRevision++;
        return removed;
    }
    static #extractImages(message) {
        const images = message.images
            .map((image, index) => {
            const match = /^data:([^;,]+);base64,(.*)$/.exec(image.image);
            if (!match)
                return null;
            const [, mimeType, data] = match;
            return {
                id: crypto.randomUUID(),
                data,
                mimeType,
                byteSize: Buffer.from(data, 'base64').length,
                displayNumber: index + 1,
            };
        })
            .filter((image) => image !== null);
        return images.length > 0 ? images : undefined;
    }
    static #extractRemovedUserTurn(message) {
        const images = ConversationStore.#extractImages(message);
        const result = {
            text: message.text,
            imageCount: images?.length ?? 0,
        };
        if (images) {
            result.images = images;
        }
        return result;
    }
    static #extractRemovedToolOutput(item, index) {
        const toolResult = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_result');
        const providerItem = item?.rawItem ?? item;
        const providerToolName = providerItem?.name ?? providerItem?.toolName;
        return {
            index,
            itemType: providerItem?.type ?? 'unknown',
            callId: toolResult?.callId,
            // Canonical normalization uses "unknown" when a provider omitted the
            // name; preserve this public method's historical `undefined` result.
            toolName: typeof providerToolName === 'string' && providerToolName ? toolResult?.toolName : undefined,
            output: toolResult?.output,
        };
    }
    #findLastToolOutputIndex() {
        for (let i = this.#history.length - 1; i >= 0; i--) {
            if (normalizeRunItem(this.#history[i]).some((item) => item.type === 'tool_result')) {
                return i;
            }
        }
        return -1;
    }
    /**
     * Returns a list of genuine user turns (excluding shell context items),
     * each with their index in the history array, text, and image count.
     */
    listUserTurns() {
        const turns = [];
        for (let i = 0; i < this.#history.length; i++) {
            const message = projectConversationMessage(this.#history[i]);
            if (message?.role !== 'user' || message.isSynthetic)
                continue;
            turns.push({ index: i, text: message.text, imageCount: message.imageCount });
        }
        return turns;
    }
    /**
     * Returns every genuine user turn the conversation can be rewound to, each
     * annotated with what rewinding there would discard. Turn numbers are 1-based
     * and are the only turn identifier exposed to the UI or to `/rewind N`.
     */
    listRewindTargets() {
        const turns = this.listUserTurns();
        return turns.map((turn, position) => {
            let discardedReplies = 0;
            const discardedFiles = [];
            for (let i = turn.index; i < this.#history.length; i++) {
                const item = this.#history[i];
                if (projectConversationMessage(item)?.role === 'assistant') {
                    discardedReplies++;
                    continue;
                }
                for (const path of ConversationStore.#extractMutatedPaths(item)) {
                    if (!discardedFiles.includes(path)) {
                        discardedFiles.push(path);
                    }
                }
            }
            return {
                id: this.#createRewindTargetId(turn.index),
                turnNumber: position + 1,
                text: turn.text,
                imageCount: turn.imageCount,
                discardedTurns: turns.length - position,
                discardedReplies,
                discardedFiles,
            };
        });
    }
    /** Reserve one existing target without mutating history. The token is valid only once. */
    reserveHistoryMutation(command) {
        const targets = this.listRewindTargets();
        if (command.kind === 'undo_count' && (!Number.isSafeInteger(command.count) || command.count <= 0))
            return { kind: 'not_found' };
        const target = command.kind === 'rewind'
            ? targets.find((entry) => entry.id === command.targetId)
            : targets.at(command.kind === 'undo_last' ? -1 : -Math.min(command.count, targets.length));
        if (!target)
            return { kind: command.kind === 'rewind' ? 'stale' : 'not_found' };
        const revision = this.#historyRevision;
        let used = false;
        return {
            kind: 'reserved',
            consume: () => {
                if (used)
                    return false;
                used = true;
                return this.#historyRevision === revision && this.listRewindTargets().some((entry) => entry.id === target.id);
            },
        };
    }
    /**
     * Atomically rewind to a previously listed target. The target is valid only
     * for the exact store snapshot that issued it; stale or unknown targets are
     * rejected without changing the transcript.
     */
    rewindToTarget(targetId) {
        const target = this.listRewindTargets().find((candidate) => candidate.id === targetId);
        if (!target)
            return null;
        const anchor = this.#findRewindTargetIndex(targetId);
        if (anchor === -1)
            return null;
        const message = projectConversationMessage(this.#history[anchor]);
        if (!message || message.role !== 'user' || message.isSynthetic)
            return null;
        const removed = ConversationStore.#extractRemovedUserTurn(message);
        this.#history.splice(anchor);
        this.#historyRevision++;
        return { ...removed, discardedTurns: target.discardedTurns };
    }
    /**
     * Pulls file paths out of a mutating tool call. Arguments arrive as a JSON
     * string from most providers and as an object from some, and apply_patch nests
     * one path per operation, so all three shapes are handled. Malformed arguments
     * yield no paths rather than throwing — a preview must never break a rewind.
     */
    static #extractMutatedPaths(item) {
        const toolCall = normalizeRunItem(item).find((normalized) => normalized.type === 'tool_call');
        if (!toolCall || !FILE_MUTATING_TOOLS.has(toolCall.toolName))
            return [];
        let args = toolCall.arguments;
        if (typeof args === 'string') {
            try {
                args = JSON.parse(args);
            }
            catch {
                return [];
            }
        }
        if (!args || typeof args !== 'object')
            return [];
        const paths = [];
        if (typeof args.path === 'string' && args.path) {
            paths.push(args.path);
        }
        if (Array.isArray(args.operations)) {
            for (const operation of args.operations) {
                if (operation && typeof operation.path === 'string' && operation.path) {
                    paths.push(operation.path);
                }
            }
        }
        return paths;
    }
    /**
     * Remove the oldest genuine user turns so that at most `maxUserTurns` remain,
     * keeping all items from the first retained turn onward. This preserves a
     * valid provider-facing transcript that starts at a user turn.
     */
    trimUserTurns(maxUserTurns) {
        if (maxUserTurns <= 0) {
            this.#history = [];
            this.#historyRevision++;
            return;
        }
        const turns = this.listUserTurns();
        if (turns.length <= maxUserTurns) {
            return;
        }
        const keepIndex = turns[turns.length - maxUserTurns].index;
        this.#history = this.#history.slice(keepIndex);
        this.#historyRevision++;
    }
    /**
     * Remove the last genuine user turn and everything after it.
     * Skips shell-context items (identified by SHELL_CONTEXT_PREFIX).
     * Used by /undo to rewind to before the last user turn.
     * Returns { text, imageCount } of the removed item, or null if none found.
     */
    removeLastUserTurn() {
        let anchor = -1;
        for (let i = this.#history.length - 1; i >= 0; i--) {
            const message = projectConversationMessage(this.#history[i]);
            if (message?.role !== 'user' || message.isSynthetic)
                continue;
            anchor = i;
            break;
        }
        if (anchor === -1)
            return null;
        const message = projectConversationMessage(this.#history[anchor]);
        if (!message)
            return null;
        const removed = ConversationStore.#extractRemovedUserTurn(message);
        this.#history.splice(anchor);
        this.#historyRevision++;
        return removed;
    }
    /**
     * Removes the last n genuine user turns (and everything after the earliest
     * one's anchor). Returns info from the earliest removed turn, or null if
     * no genuine turns found.
     */
    removeNLastUserTurns(n) {
        if (n <= 0)
            return null;
        // Walk backwards to find the nth-from-last genuine user turn
        let count = 0;
        let anchor = -1;
        for (let i = this.#history.length - 1; i >= 0; i--) {
            const message = projectConversationMessage(this.#history[i]);
            if (message?.role !== 'user' || message.isSynthetic)
                continue;
            count++;
            if (count === n) {
                anchor = i;
                break;
            }
        }
        if (anchor === -1) {
            // Fewer than n genuine user turns exist; remove all from the first one
            for (let i = 0; i < this.#history.length; i++) {
                const message = projectConversationMessage(this.#history[i]);
                if (message?.role !== 'user' || message.isSynthetic)
                    continue;
                anchor = i;
                break;
            }
            if (anchor === -1)
                return null;
        }
        const message = projectConversationMessage(this.#history[anchor]);
        if (!message)
            return null;
        const removed = ConversationStore.#extractRemovedUserTurn(message);
        this.#history.splice(anchor);
        this.#historyRevision++;
        return removed;
    }
    #createRewindTargetId(index) {
        return `rewind:${this.#historyIdentity}:${this.#historyRevision}:${index}`;
    }
    #findRewindTargetIndex(targetId) {
        for (const turn of this.listUserTurns()) {
            if (this.#createRewindTargetId(turn.index) === targetId)
                return turn.index;
        }
        return -1;
    }
    /**
     * Inject an error-context message into the history so the model receives
     * explicit feedback about what went wrong (e.g. a JSON parsing failure).
     * Uses the 'developer' role which acts as a system-level hint.
     */
    addErrorContext(errorMessage) {
        const item = {
            role: 'system',
            type: 'message',
            content: errorMessage,
        };
        this.#history.push(item);
        this.#historyRevision++;
    }
    #cloneHistory(items) {
        // Avoid leaking references to external callers.
        // structuredClone is available in modern Node; fall back to a deep copy fallback.
        try {
            return structuredClone(items);
        }
        catch {
            try {
                return JSON.parse(JSON.stringify(items));
            }
            catch {
                return items.slice();
            }
        }
    }
    #freezeHistory(items) {
        const seen = new WeakSet();
        const freeze = (value) => {
            if (!value || typeof value !== 'object' || Object.isFrozen(value) || seen.has(value))
                return value;
            seen.add(value);
            for (const child of Object.values(value))
                freeze(child);
            return Object.freeze(value);
        };
        return freeze(items);
    }
    #cloneSnapshotHistory(items) {
        try {
            return structuredClone(items);
        }
        catch {
            const seen = new WeakMap();
            const clone = (value) => {
                if (!value || typeof value !== 'object')
                    return value;
                const existing = seen.get(value);
                if (existing)
                    return existing;
                const copy = Array.isArray(value) ? [] : {};
                seen.set(value, copy);
                for (const [key, child] of Object.entries(value))
                    copy[key] = clone(child);
                return copy;
            };
            return clone(items);
        }
    }
}
//# sourceMappingURL=conversation-store.js.map