import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
const DEFAULT_GENERATION_GUARD_OPTIONS = {
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
    toolArgumentRunawayMs: 60_000,
};
/** A guard trip means the provider may have accepted work with an uncertain outcome. */
export class GenerationGuardError extends AmbiguousModelOutcomeError {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'GenerationGuardError';
        this.code = code;
    }
}
/** Owns containment accounting for exactly one provider request. */
export class GenerationGuard {
    #options;
    #textCharacters = 0;
    #reasoningCharacters = 0;
    #observableToolArgumentCharacters = 0;
    #outputCharacters = 0;
    #lastToolArgumentProgress = 0;
    #sawToolArgumentProgress = false;
    constructor(options) {
        this.#options = resolveGenerationGuardOptions(options);
    }
    get requestDeadlineMs() {
        return this.#options.requestDeadlineMs;
    }
    get maxStreamIdleMs() {
        return this.#options.maxStreamIdleMs;
    }
    get toolArgumentRunawayMs() {
        return this.#options.toolArgumentRunawayMs;
    }
    get textCharacters() {
        return this.#textCharacters;
    }
    get reasoningCharacters() {
        return this.#reasoningCharacters;
    }
    get outputCharacters() {
        return this.#outputCharacters;
    }
    get toolArgumentCharacters() {
        return this.#observableToolArgumentCharacters;
    }
    /**
     * A snapshot of what this request has produced so far. A deadline abort
     * reports it in the error message because that message is the only part of
     * the failure that survives the subagent tool-output boundary.
     */
    get progress() {
        return {
            outputCharacters: this.#outputCharacters,
            textCharacters: this.#textCharacters,
            reasoningCharacters: this.#reasoningCharacters,
            toolArgumentCharacters: this.#observableToolArgumentCharacters,
        };
    }
    observeText(text) {
        this.#addText(text.length);
    }
    /**
     * Count and retain reasoning up to the configured cap. Returns the prefix
     * that still fits so callers can stop forwarding the rest; never throws for
     * length.
     */
    observeReasoning(text) {
        if (!text)
            return text;
        const remaining = this.#options.maxReasoningCharacters - this.#reasoningCharacters;
        if (remaining <= 0)
            return '';
        const accepted = text.length > remaining ? text.slice(0, remaining) : text;
        this.#addReasoning(accepted.length);
        return accepted;
    }
    /**
     * Providers expose only a cumulative count, not raw argument deltas or a
     * call id. Count observable growth, treating a decreased count as a new
     * call. Equal counts remain neutral rather than fabricating a new argument.
     */
    observeToolArgumentProgress(argumentCharCount) {
        const reported = Math.max(0, Math.floor(argumentCharCount));
        this.#assertToolArgumentLength(reported);
        const growth = reported >= this.#lastToolArgumentProgress ? reported - this.#lastToolArgumentProgress : reported;
        this.#addObservableToolArguments(growth);
        this.#lastToolArgumentProgress = reported;
        this.#sawToolArgumentProgress = true;
    }
    /** Validate a complete tool-call argument string without retaining its content. */
    observeToolCall(argumentsText) {
        this.#assertToolArgumentLength(argumentsText.length);
        // A non-streaming adapter exposes the only observable cumulative count at
        // the terminal call. A streamed adapter already reported this call's size.
        if (!this.#sawToolArgumentProgress)
            this.#addObservableToolArguments(argumentsText.length);
        this.#lastToolArgumentProgress = 0;
        this.#sawToolArgumentProgress = false;
    }
    /**
     * Validate terminal-only provider output before it reaches history. Terminal
     * text/reasoning often repeat streamed content, so add only the unobserved
     * suffix length.
     */
    observeCompletion(output) {
        const text = output
            .filter((item) => item.type === 'message')
            .flatMap((item) => item.content)
            .map((part) => part.text)
            .join('');
        if (text.length > this.#textCharacters) {
            const unseen = text.slice(this.#textCharacters);
            this.observeText(unseen);
        }
        else {
            this.#assertTextLength(text.length);
        }
        const reasoning = output
            .filter((item) => item.type === 'reasoning')
            .map((item) => item.text)
            .join('');
        if (reasoning.length > this.#reasoningCharacters) {
            const unseen = reasoning.slice(this.#reasoningCharacters);
            this.observeReasoning(unseen);
        }
        else {
            this.#assertReasoningLength(reasoning.length);
        }
        for (const item of output) {
            if (item.type === 'tool_call')
                this.#assertToolArgumentLength(item.arguments.length);
        }
    }
    #addText(length) {
        this.#assertTextLength(this.#textCharacters + length);
        this.#addOutputCharacters(length);
        this.#textCharacters += length;
    }
    #addReasoning(length) {
        this.#assertReasoningLength(this.#reasoningCharacters + length);
        this.#reasoningCharacters += length;
    }
    #addObservableToolArguments(length) {
        const next = this.#observableToolArgumentCharacters + length;
        if (next > this.#options.maxCumulativeToolArgumentCharacters) {
            throw new GenerationGuardError('cumulative_tool_argument_characters', 'Model output was stopped because streamed tool arguments exceeded their cumulative limit.');
        }
        this.#addOutputCharacters(length);
        this.#observableToolArgumentCharacters = next;
    }
    #addOutputCharacters(length) {
        if (this.#outputCharacters + length > this.#options.maxOutputCharacters) {
            throw new GenerationGuardError('output_characters', 'Model output was stopped because it exceeded the per-request output limit.');
        }
        this.#outputCharacters += length;
    }
    #assertTextLength(length) {
        if (length > this.#options.maxTextCharacters) {
            throw new GenerationGuardError('text_characters', 'Model output was stopped because text exceeded its limit.');
        }
    }
    #assertReasoningLength(length) {
        if (length > this.#options.maxReasoningCharacters) {
            throw new GenerationGuardError('reasoning_characters', 'Model output was stopped because reasoning exceeded its limit.');
        }
    }
    #assertToolArgumentLength(length) {
        if (length > this.#options.maxToolArgumentCharacters) {
            // The length and limit travel in the message because a subagent
            // failure is re-thrown from a tool-output string: the message survives
            // that boundary and a structured payload does not.
            throw new GenerationGuardError('tool_argument_characters', `Model output was stopped because a tool argument payload of ${length} characters exceeded its limit of ${this.#options.maxToolArgumentCharacters} characters (cumulative streamed tool arguments ${this.#observableToolArgumentCharacters} of ${this.#options.maxCumulativeToolArgumentCharacters} characters).`);
        }
    }
}
/**
 * The deadline message carries the progress counters because a subagent
 * failure is re-thrown from a tool-output string: the message survives that
 * boundary and a structured payload does not.
 */
function describeDeadlineExpiry(timeoutMs, progress) {
    const base = `Model request exceeded its total deadline (${Math.round(timeoutMs / 1000)}s)`;
    if (!progress)
        return `${base}.`;
    return (`${base}; streamed ${progress.outputCharacters} output chars ` +
        `(text ${progress.textCharacters}, reasoning ${progress.reasoningCharacters}, ` +
        `tool arguments ${progress.toolArgumentCharacters}).`);
}
/** The inactivity message mirrors the deadline message so both survive the subagent tool-output boundary. */
function describeInactivityExpiry(idleMs, progress) {
    const base = `Model request stalled with no streamed output for its idle window (${Math.round(idleMs / 1000)}s)`;
    if (!progress)
        return `${base}.`;
    return (`${base}; streamed ${progress.outputCharacters} output chars ` +
        `(text ${progress.textCharacters}, reasoning ${progress.reasoningCharacters}, ` +
        `tool arguments ${progress.toolArgumentCharacters}).`);
}
/**
 * Rejects every in-flight and future wait once any armed timer fails. The
 * first failure wins and short-circuits later waits with the same error.
 */
class DeadlineGate {
    #error;
    #waitingRejectors = new Set();
    get error() {
        return this.#error;
    }
    fail(error) {
        if (this.#error)
            return;
        this.#error = error;
        for (const reject of this.#waitingRejectors)
            reject(error);
        this.#waitingRejectors.clear();
    }
    wait(operation) {
        if (this.#error)
            return Promise.reject(this.#error);
        return new Promise((resolve, reject) => {
            const rejectOnDeadline = (error) => reject(error);
            this.#waitingRejectors.add(rejectOnDeadline);
            void operation.then((value) => {
                this.#waitingRejectors.delete(rejectOnDeadline);
                if (this.#error)
                    reject(this.#error);
                else
                    resolve(value);
            }, (error) => {
                this.#waitingRejectors.delete(rejectOnDeadline);
                reject(error);
            });
        });
    }
}
export const DEFAULT_TOOL_ARGUMENT_RUNAWAY_SIGNATURE = {
    minDeltaFramesPerSecond: 45,
    maxAverageCharsPerFrame: 2.8,
    maxInterDeltaMs: 10_000,
};
/**
 * Contains the observed Luna failure where one tool call emits tiny argument
 * deltas continuously but never reaches a terminal tool-call event.
 */
export class ToolArgumentRunawayGuard {
    #options;
    #abort;
    #gate = new DeadlineGate();
    #timer;
    #firstDeltaAt;
    #lastDeltaAt;
    #lastArgumentCharacters;
    #deltaFrames = 0;
    #argumentCharacters = 0;
    #maxInterDeltaMs = 0;
    #disarmed = false;
    constructor(options, abortActiveRequest) {
        this.#options = options;
        this.#abort = abortActiveRequest;
    }
    observeText() {
        this.#disarm();
    }
    observeToolArgumentProgress(argumentCharCount) {
        if (this.#disarmed || this.#options.timeoutMs <= 0)
            return;
        const now = performance.now();
        if (!Number.isFinite(argumentCharCount) || argumentCharCount < 0) {
            this.#disarm();
            return;
        }
        const reported = Math.floor(argumentCharCount);
        if (this.#lastArgumentCharacters !== undefined && reported < this.#lastArgumentCharacters) {
            // A cumulative-count reset means another call started; the incident
            // signature is exactly one unfinished call, so do not infer a runaway.
            this.#disarm();
            return;
        }
        if (this.#firstDeltaAt === undefined) {
            this.#firstDeltaAt = now;
            this.#timer = setTimeout(() => this.#evaluate(), this.#options.timeoutMs);
            this.#timer.unref?.();
        }
        else if (this.#lastDeltaAt !== undefined) {
            this.#maxInterDeltaMs = Math.max(this.#maxInterDeltaMs, now - this.#lastDeltaAt);
        }
        const growth = this.#lastArgumentCharacters === undefined ? reported : reported - this.#lastArgumentCharacters;
        this.#argumentCharacters += growth;
        this.#lastArgumentCharacters = reported;
        this.#lastDeltaAt = now;
        this.#deltaFrames++;
        if (now - this.#firstDeltaAt >= this.#options.timeoutMs)
            this.#evaluate();
    }
    observeToolCallCompleted() {
        this.#disarm();
    }
    wait(operation) {
        return this.#gate.wait(operation);
    }
    dispose() {
        this.#disarm();
    }
    #evaluate() {
        if (this.#disarmed || this.#firstDeltaAt === undefined || this.#lastDeltaAt === undefined)
            return;
        const now = performance.now();
        const elapsedMs = Math.max(1, now - this.#firstDeltaAt);
        const maxGapMs = Math.max(this.#maxInterDeltaMs, now - this.#lastDeltaAt);
        const framesPerSecond = (this.#deltaFrames * 1_000) / elapsedMs;
        const averageCharsPerFrame = this.#argumentCharacters / Math.max(1, this.#deltaFrames);
        if (framesPerSecond < this.#options.minDeltaFramesPerSecond ||
            averageCharsPerFrame > this.#options.maxAverageCharsPerFrame ||
            maxGapMs > this.#options.maxInterDeltaMs) {
            return;
        }
        this.#disarmed = true;
        if (this.#timer !== undefined)
            clearTimeout(this.#timer);
        this.#timer = undefined;
        const error = new GenerationGuardError('tool_argument_runaway', `Model output was stopped because one tool call remained incomplete for ${Math.round(elapsedMs / 1_000)}s while streaming ${this.#deltaFrames} argument deltas (${framesPerSecond.toFixed(1)} frames/s, ${averageCharsPerFrame.toFixed(2)} chars/frame, max gap ${maxGapMs}ms).`);
        this.#gate.fail(error);
        this.#abort();
    }
    #disarm() {
        this.#disarmed = true;
        if (this.#timer !== undefined)
            clearTimeout(this.#timer);
        this.#timer = undefined;
    }
}
/**
 * Races stream reads against two independent limits that both abort the active
 * provider request: an optional total wall-clock ceiling (opt-in) and a
 * provider-neutral inactivity window that re-arms on every streamed event.
 */
export class GenerationStreamDeadlines {
    #gate = new DeadlineGate();
    #idleMs;
    #abort;
    #describeProgress;
    #totalTimer;
    #idleTimer;
    constructor(options, abortActiveRequest, describeProgress) {
        this.#idleMs = options.idleMs;
        this.#abort = abortActiveRequest;
        this.#describeProgress = describeProgress;
        if (options.totalMs > 0) {
            this.#totalTimer = setTimeout(() => this.#fail('request_deadline', describeDeadlineExpiry(options.totalMs, this.#describeProgress?.())), options.totalMs);
            // A safety deadline must not keep an otherwise finished CLI process alive.
            this.#totalTimer.unref?.();
        }
        this.#armIdle();
    }
    /** Reset the inactivity window; called for every streamed event. */
    recordActivity() {
        if (this.#gate.error || this.#idleMs <= 0)
            return;
        if (this.#idleTimer !== undefined)
            clearTimeout(this.#idleTimer);
        this.#armIdle();
    }
    wait(operation) {
        return this.#gate.wait(operation);
    }
    dispose() {
        if (this.#totalTimer !== undefined)
            clearTimeout(this.#totalTimer);
        if (this.#idleTimer !== undefined)
            clearTimeout(this.#idleTimer);
    }
    #armIdle() {
        if (this.#idleMs <= 0)
            return;
        this.#idleTimer = setTimeout(() => this.#fail('stream_inactivity', describeInactivityExpiry(this.#idleMs, this.#describeProgress?.())), this.#idleMs);
        this.#idleTimer.unref?.();
    }
    #fail(code, message) {
        this.#gate.fail(new GenerationGuardError(code, message));
        this.#abort();
    }
}
function resolveGenerationGuardOptions(options) {
    return {
        maxOutputCharacters: options?.maxOutputCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxOutputCharacters,
        maxTextCharacters: options?.maxTextCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxTextCharacters,
        maxReasoningCharacters: options?.maxReasoningCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxReasoningCharacters,
        maxToolArgumentCharacters: options?.maxToolArgumentCharacters ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxToolArgumentCharacters,
        maxCumulativeToolArgumentCharacters: options?.maxCumulativeToolArgumentCharacters ??
            DEFAULT_GENERATION_GUARD_OPTIONS.maxCumulativeToolArgumentCharacters,
        requestDeadlineMs: options?.requestDeadlineMs ?? DEFAULT_GENERATION_GUARD_OPTIONS.requestDeadlineMs,
        maxStreamIdleMs: options?.maxStreamIdleMs ?? DEFAULT_GENERATION_GUARD_OPTIONS.maxStreamIdleMs,
        toolArgumentRunawayMs: options?.toolArgumentRunawayMs ?? DEFAULT_GENERATION_GUARD_OPTIONS.toolArgumentRunawayMs,
    };
}
//# sourceMappingURL=generation-guard.js.map