import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import type { StreamedModelTurnOutput } from '../../contracts/streamed-model-turn.js';

export type GenerationGuardCode =
  | 'text_characters'
  | 'reasoning_characters'
  | 'tool_argument_characters'
  | 'cumulative_tool_argument_characters'
  | 'output_characters'
  | 'repetitive_text'
  | 'repetitive_reasoning'
  | 'request_deadline'
  | 'stream_inactivity';

/**
 * A provider-neutral, per-request generation budget. Text and streamed tool
 * arguments fail closed when they exceed their caps: they are the visible or
 * executed payload. Reasoning is a scratch channel — verbose high-effort
 * models produce far more of it than 100k characters without looping — so
 * that cap truncates what we retain and does not abort the request. Reasoning
 * does not consume the aggregate output budget, or one long thought would
 * starve later text and tool calls.
 */
export interface GenerationGuardOptions {
  readonly maxOutputCharacters?: number;
  readonly maxTextCharacters?: number;
  readonly maxReasoningCharacters?: number;
  readonly maxToolArgumentCharacters?: number;
  readonly maxCumulativeToolArgumentCharacters?: number;
  /** Optional total wall-clock ceiling; 0 disables it. Opt-in backstop only. */
  readonly requestDeadlineMs?: number;
  /**
   * Provider-neutral inactivity window: abort if no streamed delta arrives
   * within this many ms. Re-arms on every streamed event, so long legitimate
   * reasoning that keeps emitting survives while a silent stall is cut. 0
   * disables it.
   */
  readonly maxStreamIdleMs?: number;
  readonly repetition?: Partial<GenerationRepetitionOptions>;
}

export interface GenerationRepetitionOptions {
  readonly minRepeatedCharacters: number;
  readonly minRepetitions: number;
  readonly maxPatternCharacters: number;
  readonly retainedWindowCharacters: number;
}

export const DEFAULT_GENERATION_REPETITION_OPTIONS: Readonly<GenerationRepetitionOptions> = {
  minRepeatedCharacters: 4_096,
  minRepetitions: 3,
  maxPatternCharacters: 4_096,
  retainedWindowCharacters: 32_768,
};

export const DEFAULT_GENERATION_GUARD_OPTIONS: Readonly<Required<Omit<GenerationGuardOptions, 'repetition'>>> & {
  readonly repetition: Readonly<GenerationRepetitionOptions>;
} = {
  maxOutputCharacters: 100_000,
  maxTextCharacters: 100_000,
  maxReasoningCharacters: 100_000,
  maxToolArgumentCharacters: 100_000,
  maxCumulativeToolArgumentCharacters: 100_000,
  // A total wall-clock deadline cannot distinguish slow-but-active reasoning
  // from a stalled provider, so keep it opt-in (off by default). The stream
  // -idle watchdog below owns inactivity for every provider: it re-arms on
  // each streamed delta, so long legitimate thinking survives while true
  // silence is cut. 600s matches the proven Codex inter-frame value and lets a
  // provider that buffers its whole answer for minutes still deliver it.
  requestDeadlineMs: 0,
  maxStreamIdleMs: 600_000,
  repetition: DEFAULT_GENERATION_REPETITION_OPTIONS,
};

type ResolvedGenerationGuardOptions = Required<Omit<GenerationGuardOptions, 'repetition'>> & {
  repetition: GenerationRepetitionOptions;
};

/** A guard trip means the provider may have accepted work with an uncertain outcome. */
export class GenerationGuardError extends AmbiguousModelOutcomeError {
  readonly code: GenerationGuardCode;

  constructor(code: GenerationGuardCode, message: string) {
    super(message);
    this.name = 'GenerationGuardError';
    this.code = code;
  }
}

/** Bounded exact-periodic-suffix detector, intentionally preserving whitespace. */
class RepetitionDetector {
  #text = '';
  #observedCharacters = 0;
  #nextCheckAt: number;

  constructor(private readonly options: GenerationRepetitionOptions) {
    this.#nextCheckAt = options.minRepeatedCharacters;
  }

  append(delta: string): boolean {
    this.#observedCharacters += delta.length;
    this.#text = (this.#text + delta).slice(-this.options.retainedWindowCharacters);
    if (this.#text.trim().length === 0) return false;
    if (this.#observedCharacters < this.#nextCheckAt) return false;

    // Rechecking every token would turn a long, ordinary response into a
    // repeated O(window) scan. A bounded lag is harmless—the output ceiling
    // remains exact—and keeps detector work near-linear in output size.
    this.#nextCheckAt =
      this.#observedCharacters + Math.max(1, Math.min(256, Math.floor(this.options.minRepeatedCharacters / 4)));
    return hasRepeatedSuffix(this.#text, this.options);
  }
}

/**
 * Z-values make equality of a suffix's repeated blocks an O(1) query per
 * candidate period after one O(window) scan of the reversed bounded buffer.
 */
function hasRepeatedSuffix(text: string, options: GenerationRepetitionOptions): boolean {
  const reversed = text.split('').reverse().join('');
  const z = zValues(reversed);
  const maxPatternLength = Math.min(options.maxPatternCharacters, Math.floor(text.length / options.minRepetitions));
  for (let patternLength = 1; patternLength <= maxPatternLength; patternLength++) {
    const repetitions = Math.max(options.minRepetitions, Math.ceil(options.minRepeatedCharacters / patternLength));
    const repeatedLength = patternLength * repetitions;
    if (repeatedLength > text.length || z[patternLength]! < repeatedLength - patternLength) continue;
    if (text.slice(-patternLength).trim().length > 0) return true;
  }
  return false;
}

function zValues(value: string): Uint32Array {
  const z = new Uint32Array(value.length);
  let left = 0;
  let right = 0;
  for (let index = 1; index < value.length; index++) {
    if (index <= right) z[index] = Math.min(right - index + 1, z[index - left]!);
    while (index + z[index]! < value.length && value[z[index]!] === value[index + z[index]!]) z[index]! += 1;
    if (index + z[index]! > right) {
      left = index;
      right = index + z[index]! - 1;
    }
  }
  return z;
}

export interface GenerationProgress {
  readonly outputCharacters: number;
  readonly textCharacters: number;
  readonly reasoningCharacters: number;
  readonly toolArgumentCharacters: number;
}

/** Owns counting and repetition state for exactly one provider request. */
export class GenerationGuard {
  readonly #options: ResolvedGenerationGuardOptions;
  readonly #textRepetition: RepetitionDetector;
  readonly #reasoningRepetition: RepetitionDetector;
  #textCharacters = 0;
  #reasoningCharacters = 0;
  #observableToolArgumentCharacters = 0;
  #outputCharacters = 0;
  #lastToolArgumentProgress = 0;
  #sawToolArgumentProgress = false;

  constructor(options?: GenerationGuardOptions) {
    this.#options = resolveGenerationGuardOptions(options);
    this.#textRepetition = new RepetitionDetector(this.#options.repetition);
    this.#reasoningRepetition = new RepetitionDetector(this.#options.repetition);
  }

  get requestDeadlineMs(): number {
    return this.#options.requestDeadlineMs;
  }

  get maxStreamIdleMs(): number {
    return this.#options.maxStreamIdleMs;
  }

  get textCharacters(): number {
    return this.#textCharacters;
  }

  get reasoningCharacters(): number {
    return this.#reasoningCharacters;
  }

  get outputCharacters(): number {
    return this.#outputCharacters;
  }

  get toolArgumentCharacters(): number {
    return this.#observableToolArgumentCharacters;
  }

  /**
   * A snapshot of what this request has produced so far. A deadline abort
   * reports it in the error message because that message is the only part of
   * the failure that survives the subagent tool-output boundary.
   */
  get progress(): GenerationProgress {
    return {
      outputCharacters: this.#outputCharacters,
      textCharacters: this.#textCharacters,
      reasoningCharacters: this.#reasoningCharacters,
      toolArgumentCharacters: this.#observableToolArgumentCharacters,
    };
  }

  observeText(text: string): void {
    this.#addText(text.length);
    if (this.#textRepetition.append(text)) {
      throw new GenerationGuardError(
        'repetitive_text',
        'Model output was stopped because text entered a repeating pattern.',
      );
    }
  }

  /**
   * Count and retain reasoning up to the configured cap. Returns the prefix
   * that still fits so callers can stop forwarding the rest; never throws for
   * length. Repetition on the retained prefix remains fail-closed.
   */
  observeReasoning(text: string): string {
    if (!text) return text;
    const remaining = this.#options.maxReasoningCharacters - this.#reasoningCharacters;
    if (remaining <= 0) return '';
    const accepted = text.length > remaining ? text.slice(0, remaining) : text;
    this.#addReasoning(accepted.length);
    if (this.#reasoningRepetition.append(accepted)) {
      throw new GenerationGuardError(
        'repetitive_reasoning',
        'Model output was stopped because reasoning entered a repeating pattern.',
      );
    }
    return accepted;
  }

  /**
   * Providers expose only a cumulative count, not raw argument deltas or a
   * call id. Count observable growth, treating a decreased count as a new
   * call. Equal counts remain neutral rather than fabricating a new argument.
   */
  observeToolArgumentProgress(argumentCharCount: number): void {
    const reported = Math.max(0, Math.floor(argumentCharCount));
    this.#assertToolArgumentLength(reported);
    const growth = reported >= this.#lastToolArgumentProgress ? reported - this.#lastToolArgumentProgress : reported;
    this.#addObservableToolArguments(growth);
    this.#lastToolArgumentProgress = reported;
    this.#sawToolArgumentProgress = true;
  }

  /** Validate a complete tool-call argument string without retaining its content. */
  observeToolCall(argumentsText: string): void {
    this.#assertToolArgumentLength(argumentsText.length);
    // A non-streaming adapter exposes the only observable cumulative count at
    // the terminal call. A streamed adapter already reported this call's size.
    if (!this.#sawToolArgumentProgress) this.#addObservableToolArguments(argumentsText.length);
    this.#lastToolArgumentProgress = 0;
    this.#sawToolArgumentProgress = false;
  }

  /**
   * Validate terminal-only provider output before it reaches history. Terminal
   * text/reasoning often repeat streamed content, so add only the unobserved
   * suffix length; repetition is evaluated only when this is the sole copy.
   */
  observeCompletion(output: readonly StreamedModelTurnOutput[]): void {
    const text = output
      .filter((item): item is Extract<StreamedModelTurnOutput, { type: 'message' }> => item.type === 'message')
      .flatMap((item) => item.content)
      .map((part) => part.text)
      .join('');
    if (text.length > this.#textCharacters) {
      const unseen = text.slice(this.#textCharacters);
      this.observeText(unseen);
    } else {
      this.#assertTextLength(text.length);
    }

    const reasoning = output
      .filter((item): item is Extract<StreamedModelTurnOutput, { type: 'reasoning' }> => item.type === 'reasoning')
      .map((item) => item.text)
      .join('');
    if (reasoning.length > this.#reasoningCharacters) {
      const unseen = reasoning.slice(this.#reasoningCharacters);
      this.observeReasoning(unseen);
    } else {
      this.#assertReasoningLength(reasoning.length);
    }

    for (const item of output) {
      if (item.type === 'tool_call') this.#assertToolArgumentLength(item.arguments.length);
    }
  }

  #addText(length: number): void {
    this.#assertTextLength(this.#textCharacters + length);
    this.#addOutputCharacters(length);
    this.#textCharacters += length;
  }

  #addReasoning(length: number): void {
    this.#assertReasoningLength(this.#reasoningCharacters + length);
    this.#reasoningCharacters += length;
  }

  #addObservableToolArguments(length: number): void {
    const next = this.#observableToolArgumentCharacters + length;
    if (next > this.#options.maxCumulativeToolArgumentCharacters) {
      throw new GenerationGuardError(
        'cumulative_tool_argument_characters',
        'Model output was stopped because streamed tool arguments exceeded their cumulative limit.',
      );
    }
    this.#addOutputCharacters(length);
    this.#observableToolArgumentCharacters = next;
  }

  #addOutputCharacters(length: number): void {
    if (this.#outputCharacters + length > this.#options.maxOutputCharacters) {
      throw new GenerationGuardError(
        'output_characters',
        'Model output was stopped because it exceeded the per-request output limit.',
      );
    }
    this.#outputCharacters += length;
  }

  #assertTextLength(length: number): void {
    if (length > this.#options.maxTextCharacters) {
      throw new GenerationGuardError('text_characters', 'Model output was stopped because text exceeded its limit.');
    }
  }

  #assertReasoningLength(length: number): void {
    if (length > this.#options.maxReasoningCharacters) {
      throw new GenerationGuardError(
        'reasoning_characters',
        'Model output was stopped because reasoning exceeded its limit.',
      );
    }
  }

  #assertToolArgumentLength(length: number): void {
    if (length > this.#options.maxToolArgumentCharacters) {
      throw new GenerationGuardError(
        'tool_argument_characters',
        'Model output was stopped because a tool argument payload exceeded its limit.',
      );
    }
  }
}

/**
 * The deadline message carries the progress counters because a subagent
 * failure is re-thrown from a tool-output string: the message survives that
 * boundary and a structured payload does not.
 */
function describeDeadlineExpiry(timeoutMs: number, progress: GenerationProgress | undefined): string {
  const base = `Model request exceeded its total deadline (${Math.round(timeoutMs / 1000)}s)`;
  if (!progress) return `${base}.`;
  return (
    `${base}; streamed ${progress.outputCharacters} output chars ` +
    `(text ${progress.textCharacters}, reasoning ${progress.reasoningCharacters}, ` +
    `tool arguments ${progress.toolArgumentCharacters}).`
  );
}

/** The inactivity message mirrors the deadline message so both survive the subagent tool-output boundary. */
function describeInactivityExpiry(idleMs: number, progress: GenerationProgress | undefined): string {
  const base = `Model request stalled with no streamed output for its idle window (${Math.round(idleMs / 1000)}s)`;
  if (!progress) return `${base}.`;
  return (
    `${base}; streamed ${progress.outputCharacters} output chars ` +
    `(text ${progress.textCharacters}, reasoning ${progress.reasoningCharacters}, ` +
    `tool arguments ${progress.toolArgumentCharacters}).`
  );
}

/**
 * Rejects every in-flight and future wait once any armed timer fails. The
 * first failure wins and short-circuits later waits with the same error.
 */
class DeadlineGate {
  #error: GenerationGuardError | undefined;
  readonly #waitingRejectors = new Set<(error: GenerationGuardError) => void>();

  get error(): GenerationGuardError | undefined {
    return this.#error;
  }

  fail(error: GenerationGuardError): void {
    if (this.#error) return;
    this.#error = error;
    for (const reject of this.#waitingRejectors) reject(error);
    this.#waitingRejectors.clear();
  }

  wait<T>(operation: Promise<T>): Promise<T> {
    if (this.#error) return Promise.reject(this.#error);
    return new Promise<T>((resolve, reject) => {
      const rejectOnDeadline = (error: GenerationGuardError) => reject(error);
      this.#waitingRejectors.add(rejectOnDeadline);
      void operation.then(
        (value) => {
          this.#waitingRejectors.delete(rejectOnDeadline);
          if (this.#error) reject(this.#error);
          else resolve(value);
        },
        (error) => {
          this.#waitingRejectors.delete(rejectOnDeadline);
          reject(error);
        },
      );
    });
  }
}

/**
 * Races stream reads against two independent limits that both abort the active
 * provider request: an optional total wall-clock ceiling (opt-in) and a
 * provider-neutral inactivity window that re-arms on every streamed event.
 */
export class GenerationStreamDeadlines {
  readonly #gate = new DeadlineGate();
  readonly #idleMs: number;
  readonly #abort: () => void;
  readonly #describeProgress?: () => GenerationProgress;
  #totalTimer: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    options: { readonly totalMs: number; readonly idleMs: number },
    abortActiveRequest: () => void,
    describeProgress?: () => GenerationProgress,
  ) {
    this.#idleMs = options.idleMs;
    this.#abort = abortActiveRequest;
    this.#describeProgress = describeProgress;
    if (options.totalMs > 0) {
      this.#totalTimer = setTimeout(
        () => this.#fail('request_deadline', describeDeadlineExpiry(options.totalMs, this.#describeProgress?.())),
        options.totalMs,
      );
      // A safety deadline must not keep an otherwise finished CLI process alive.
      this.#totalTimer.unref?.();
    }
    this.#armIdle();
  }

  /** Reset the inactivity window; called for every streamed event. */
  recordActivity(): void {
    if (this.#gate.error || this.#idleMs <= 0) return;
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#armIdle();
  }

  wait<T>(operation: Promise<T>): Promise<T> {
    return this.#gate.wait(operation);
  }

  dispose(): void {
    if (this.#totalTimer !== undefined) clearTimeout(this.#totalTimer);
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
  }

  #armIdle(): void {
    if (this.#idleMs <= 0) return;
    this.#idleTimer = setTimeout(
      () => this.#fail('stream_inactivity', describeInactivityExpiry(this.#idleMs, this.#describeProgress?.())),
      this.#idleMs,
    );
    this.#idleTimer.unref?.();
  }

  #fail(code: GenerationGuardCode, message: string): void {
    this.#gate.fail(new GenerationGuardError(code, message));
    this.#abort();
  }
}

export function resolveGenerationGuardOptions(options?: GenerationGuardOptions): ResolvedGenerationGuardOptions {
  return {
    maxOutputCharacters: options?.maxOutputCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxOutputCharacters,
    maxTextCharacters: options?.maxTextCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxTextCharacters,
    maxReasoningCharacters: options?.maxReasoningCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxReasoningCharacters,
    maxToolArgumentCharacters:
      options?.maxToolArgumentCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxToolArgumentCharacters,
    maxCumulativeToolArgumentCharacters:
      options?.maxCumulativeToolArgumentCharacters ??
      DEFAULT_GENERATION_GUARD_OPTIONS.maxCumulativeToolArgumentCharacters,
    requestDeadlineMs: options?.requestDeadlineMs ?? DEFAULT_GENERATION_GUARD_OPTIONS.requestDeadlineMs,
    maxStreamIdleMs: options?.maxStreamIdleMs ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxStreamIdleMs,
    repetition: { ...DEFAULT_GENERATION_REPETITION_OPTIONS, ...options?.repetition },
  };
}
