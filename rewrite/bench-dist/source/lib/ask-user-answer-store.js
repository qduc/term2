export class AskUserAnswerStore {
    #answers = new Map();
    set(callId, answer) {
        this.#answers.set(callId, answer);
    }
    /** Read + delete in one operation (one-shot consumption). */
    consume(callId) {
        const answer = this.#answers.get(callId);
        if (answer !== undefined) {
            this.#answers.delete(callId);
        }
        return answer;
    }
    /** Read without deleting. */
    peek(callId) {
        return this.#answers.get(callId);
    }
    clear() {
        this.#answers.clear();
    }
}
//# sourceMappingURL=ask-user-answer-store.js.map