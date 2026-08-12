export class AmbiguousModelOutcomeError extends Error {
  readonly unsafeToReplay = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AmbiguousModelOutcomeError';
  }
}

export class ConversationStateNoProgressError extends Error {
  readonly unrecoverable = true;

  constructor(message = 'Local conversation history is structurally incomplete and retry would not make progress.') {
    super(message);
    this.name = 'ConversationStateNoProgressError';
  }
}
