export class AmbiguousModelOutcomeError extends Error {
  readonly unsafeToReplay = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AmbiguousModelOutcomeError';
  }
}
