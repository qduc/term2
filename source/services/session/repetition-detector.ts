const DEFAULT_MIN_REPEATED_CHARACTERS = 200;
const DEFAULT_MIN_REPETITIONS = 8;
const DEFAULT_MAX_PATTERN_LENGTH = 200;
const DEFAULT_WINDOW_SIZE = 4_000;

/** Detects an immediately repeated suffix while keeping only bounded stream state. */
export class RepetitionDetector {
  #text = '';

  append(delta: string): boolean {
    this.#text = (this.#text + delta).slice(-DEFAULT_WINDOW_SIZE);
    if (this.#text.trim().length === 0) return false;

    const maxPatternLength = Math.min(
      DEFAULT_MAX_PATTERN_LENGTH,
      Math.floor(this.#text.length / DEFAULT_MIN_REPETITIONS),
    );

    for (let patternLength = 1; patternLength <= maxPatternLength; patternLength++) {
      const repetitions = Math.max(DEFAULT_MIN_REPETITIONS, Math.ceil(DEFAULT_MIN_REPEATED_CHARACTERS / patternLength));
      const repeatedLength = patternLength * repetitions;
      if (repeatedLength > this.#text.length) continue;

      const pattern = this.#text.slice(-patternLength);
      if (pattern.trim().length === 0) continue;

      let matches = true;
      for (let offset = patternLength; offset < repeatedLength; offset += patternLength) {
        if (this.#text.slice(-offset - patternLength, -offset) !== pattern) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }

    return false;
  }
}

export class RepetitiveModelOutputError extends Error {
  readonly code = 'repetitive_model_output';

  constructor() {
    super('Model output was stopped because it entered a repeating pattern.');
    this.name = 'RepetitiveModelOutputError';
  }
}
