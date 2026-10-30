import { ConversationStore } from '../conversation/conversation-store.js';
import { waitForAbortableRead } from '../../contracts/abort-aware-wait.js';
export class SubagentSession {
    id;
    role;
    #provider = null;
    #model = null;
    #agent = null;
    #store = null;
    #previousResponseId = null;
    #toolLedger = [];
    constructor(id, role) {
        this.id = id;
        this.role = role;
    }
    get provider() {
        return this.#provider;
    }
    get model() {
        return this.#model;
    }
    get agent() {
        return this.#agent;
    }
    get previousResponseId() {
        return this.#previousResponseId;
    }
    reset() {
        if (this.#store) {
            this.#store.clear();
        }
        this.#previousResponseId = null;
        this.#toolLedger = [];
        this.#store = null;
        this.#model = null;
        this.#provider = null;
        this.#agent = null;
    }
    exportState() {
        return {
            history: this.#store?.getHistory() ?? [],
            previousResponseId: this.#previousResponseId,
            toolLedger: [...this.#toolLedger],
        };
    }
    importState(state) {
        this.#store?.clear();
        if (!this.#store) {
            this.#store = new ConversationStore();
        }
        for (const item of state.history ?? []) {
            this.#store.addImportedItem(item);
        }
        this.#previousResponseId = state.previousResponseId ?? null;
        this.#toolLedger = state.toolLedger ? [...state.toolLedger] : [];
    }
    getUserTurnCount() {
        return this.#store?.listUserTurns().length ?? 0;
    }
    trimHistory(maxUserTurns) {
        this.#store?.trimUserTurns(maxUserTurns);
    }
    switchProvider(provider) {
        if (this.#provider !== provider) {
            this.#agent = null;
            this.#store = null;
            this.#previousResponseId = null;
            this.#model = null;
            this.#provider = provider;
        }
    }
    async ensureModel(provider, createModel, wait) {
        if (!this.#model) {
            const operation = createModel(provider);
            const model = wait
                ? await waitForAbortableRead(Promise.resolve(operation), wait.signal, wait.onDetached)
                : await operation;
            if (wait)
                wait.signal.throwIfAborted();
            this.#model = model;
        }
        return this.#model;
    }
    ensureAgent(createAgent) {
        if (!this.#agent) {
            this.#agent = createAgent();
            this.#store = new ConversationStore();
        }
        return this.#agent;
    }
    addUserMessage(message) {
        this.#store.addUserMessage(message);
    }
    getInput(task, supportsConversationChaining) {
        return supportsConversationChaining ? task : this.#store.getHistory();
    }
    getRunOptions(supportsConversationChaining, maxTurns) {
        return {
            stream: false,
            maxTurns,
            ...(supportsConversationChaining && this.#previousResponseId
                ? { previousResponseId: this.#previousResponseId }
                : {}),
        };
    }
    appendOutput(result) {
        const items = (result.output ?? result.history ?? []).flatMap((event) => event?.type === 'item' && event.item ? [event.item] : [event]);
        this.#store.appendOutput(items);
        if (result.lastResponseId)
            this.#previousResponseId = result.lastResponseId;
    }
    setToolLedger(toolLedger) {
        this.#toolLedger = [...toolLedger];
    }
}
//# sourceMappingURL=subagent-session.js.map