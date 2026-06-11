export class AskUserAnswerStore {
  #answers = new Map<string, string>();

  set(callId: string, answer: string): void {
    this.#answers.set(callId, answer);
  }

  /** Read + delete in one operation (one-shot consumption). */
  consume(callId: string): string | undefined {
    const answer = this.#answers.get(callId);
    if (answer !== undefined) {
      this.#answers.delete(callId);
    }
    return answer;
  }

  /** Read without deleting. */
  peek(callId: string): string | undefined {
    return this.#answers.get(callId);
  }
}
