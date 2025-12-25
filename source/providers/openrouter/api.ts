import type {ISettingsService} from '../../services/service-interfaces.js';
import {getOpenRouterBaseUrl} from './utils.js';
import {extractModelSettingsForRequest} from './converters.js';

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type SleepImpl = (ms: number, signal?: AbortSignal) => Promise<void>;

export type OpenRouterRetryOptions = {
    /**
     * Number of retries after the initial attempt.
     * Example: maxRetries=2 => up to 3 total attempts.
     */
    maxRetries?: number;
    /** Base delay for exponential backoff (ms). */
    baseDelayMs?: number;
    /** Max delay cap (ms). */
    maxDelayMs?: number;
    /**
     * Jitter factor. 1 = full jitter (random 0..delay), 0 = no jitter (exact delay).
     */
    jitter?: number;
};

function isAbortError(err: unknown): boolean {
    return (
        (err instanceof DOMException && err.name === 'AbortError') ||
        (typeof err === 'object' &&
            err !== null &&
            (err as any).name === 'AbortError')
    );
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const id = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);

        const onAbort = () => {
            cleanup();
            clearTimeout(id);
            reject(new DOMException('Aborted', 'AbortError'));
        };

        const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
        };

        if (signal) {
            if (signal.aborted) {
                onAbort();
                return;
            }
            signal.addEventListener('abort', onAbort);
        }
    });
}

function parseRetryAfterToMs(value: string | undefined): number | undefined {
    if (!value) return undefined;

    // Retry-After can be seconds or an HTTP date.
    const asSeconds = Number.parseInt(value, 10);
    if (Number.isFinite(asSeconds)) {
        return Math.max(0, asSeconds) * 1000;
    }

    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) {
        return Math.max(0, asDate - Date.now());
    }

    return undefined;
}

function isRetryableStatus(status: number): boolean {
    // 408 can occur for upstream timeouts; treat as transient.
    return status === 429 || status === 408 || status >= 500;
}

function computeRetryDelayMs(opts: {
    attemptIndex: number;
    retryAfterMs?: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: number;
}): number {
    if (typeof opts.retryAfterMs === 'number' && opts.retryAfterMs >= 0) {
        return opts.retryAfterMs;
    }

    const exponential = opts.baseDelayMs * Math.pow(2, opts.attemptIndex);
    const capped = Math.min(exponential, opts.maxDelayMs);
    if (opts.jitter > 0) {
        return Math.random() * capped;
    }
    return capped;
}

export class OpenRouterError extends Error {
    status: number;
    headers: Record<string, string>;
    responseBody?: string;

    constructor(
        message: string,
        status: number,
        headers: Record<string, string>,
        responseBody?: string,
    ) {
        super(message);
        this.name = 'OpenRouterError';
        this.status = status;
        this.headers = headers;
        this.responseBody = responseBody;
    }
}

export async function callOpenRouter({
    apiKey,
    model,
    messages,
    stream,
    signal,
    settings,
    tools,
    settingsService,
    fetchImpl,
    sleepImpl,
    retry,
}: {
    apiKey: string;
    model: string;
    messages: any[];
    stream: boolean;
    signal?: AbortSignal;
    settings?: any;
    tools?: any[];
    settingsService: ISettingsService;
    fetchImpl?: FetchImpl;
    sleepImpl?: SleepImpl;
    retry?: OpenRouterRetryOptions;
}): Promise<Response> {
    const url = `${getOpenRouterBaseUrl(settingsService)}/chat/completions`;
    const body: any = {
        model,
        messages,
        stream,
    };

    // Merge settings into request body
    const settingsParams = extractModelSettingsForRequest(settings);
    Object.assign(body, settingsParams);

    // Add tools if provided
    const functionTools = tools ?? [];
    body.tools = functionTools;
    if (functionTools.length > 0) {
        body.tool_choice = 'auto'; // Let model choose when to use tools
    }

    const effectiveFetch: FetchImpl = fetchImpl ?? (fetch as any);
    const effectiveSleep: SleepImpl = sleepImpl ?? defaultSleep;
    const retryCfg: Required<OpenRouterRetryOptions> = {
        maxRetries: retry?.maxRetries ?? 2,
        baseDelayMs: retry?.baseDelayMs ?? 500,
        maxDelayMs: retry?.maxDelayMs ?? 30000,
        jitter: retry?.jitter ?? 1,
    };

    let attemptIndex = 0;
    // attemptIndex tracks the retry attempt number (0 for first retry).
    // We allow up to maxRetries retries after the initial attempt.
    while (true) {
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }

        try {
            const res = await effectiveFetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'HTTP-Referer':
                        settingsService.get('agent.openrouter.referrer') ||
                        'http://localhost',
                    'X-Title':
                        settingsService.get('agent.openrouter.title') ||
                        'term2',
                },
                body: JSON.stringify(body),
                signal,
            });

            if (res.ok) return res;

            let errText: any;
            try {
                errText = await res.text();
            } catch {}

            // Extract headers for retry logic (especially Retry-After)
            const headers: Record<string, string> = {};
            res.headers.forEach((value, key) => {
                headers[key.toLowerCase()] = value;
            });

            const message = `OpenRouter request failed: ${res.status} ${
                res.statusText
            }${errText ? ` - ${errText}` : ''}`;

            const error = new OpenRouterError(
                message,
                res.status,
                headers,
                errText,
            );
            const canRetry =
                retryCfg.maxRetries > 0 &&
                isRetryableStatus(res.status) &&
                attemptIndex < retryCfg.maxRetries;

            if (!canRetry) throw error;

            const retryAfterMs = parseRetryAfterToMs(headers['retry-after']);
            const delayMs = computeRetryDelayMs({
                attemptIndex,
                retryAfterMs,
                baseDelayMs: retryCfg.baseDelayMs,
                maxDelayMs: retryCfg.maxDelayMs,
                jitter: retryCfg.jitter,
            });

            await effectiveSleep(delayMs, signal);
            attemptIndex++;
            continue;
        } catch (err) {
            if (isAbortError(err) || signal?.aborted) throw err;

            // Network-level failures (DNS, connection reset, etc.) often surface as TypeError.
            const isNetworkError = err instanceof TypeError;
            const canRetry =
                isNetworkError &&
                retryCfg.maxRetries > 0 &&
                attemptIndex < retryCfg.maxRetries;

            if (!canRetry) throw err;

            const delayMs = computeRetryDelayMs({
                attemptIndex,
                baseDelayMs: retryCfg.baseDelayMs,
                maxDelayMs: retryCfg.maxDelayMs,
                jitter: retryCfg.jitter,
            });
            await effectiveSleep(delayMs, signal);
            attemptIndex++;
        }
    }
}
