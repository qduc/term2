import { randomUUID } from 'node:crypto';
import type { FetchMiddleware } from '../../source/providers/fetch/compose.js';
import { sanitizeHeaders } from '../../source/utils/header-sanitizer.js';
import {
  validateFixtureEnvelope,
  type FixtureEnvelopeV1,
  type FixtureFrame,
  type HttpRequestFrame,
  type HttpResponseHeadFrame,
  type SseEventFrame,
  type JsonBodyFrame,
  type WsMessageFrame,
} from './fixture-envelope.js';

export type FixtureRecorderOptions = Pick<FixtureEnvelopeV1, 'provider' | 'wireFamily' | 'transport' | 'capture'> & {
  turns?: FixtureEnvelopeV1['turns'];
  placeholders?: Record<string, string>;
};

export type FixtureRecorder = {
  recordRequest(frame: Omit<HttpRequestFrame, 'seq'>): void;
  recordResponseHead(frame: Omit<HttpResponseHeadFrame, 'seq'>): void;
  recordSseEvent(frame: Omit<SseEventFrame, 'seq'>): void;
  recordJsonBody(frame: Omit<JsonBodyFrame, 'seq'>): void;
  recordWsMessage(frame: Omit<WsMessageFrame, 'seq'>): void;
  /** Starts a new HTTP turn or WebSocket session in the same recording. */
  startTurn(): void;
  finish(): FixtureEnvelopeV1;
  flush(): Promise<FixtureEnvelopeV1>;
};

export function createFixtureRecorder(options: FixtureRecorderOptions): FixtureRecorder {
  const turns = options.turns ? structuredClone(options.turns) : [];
  let current = turns.at(-1);
  const placeholders = { ...(options.placeholders ?? {}) };
  const add = (frame: Omit<FixtureFrame, 'seq'>): void => {
    if (!current || frame.kind === 'http-request' || (frame.kind === 'ws-message' && !current.frames.length)) {
      current = { frames: [] };
      turns.push(current);
    }
    current.frames.push({ ...frame, seq: current.frames.length } as FixtureFrame);
  };
  return {
    recordRequest: add,
    recordResponseHead: add,
    recordSseEvent: add,
    recordJsonBody: add,
    recordWsMessage: add,
    startTurn: () => {
      current = { frames: [] };
      turns.push(current);
    },
    finish: () => {
      const envelope: FixtureEnvelopeV1 = {
        schemaVersion: 1,
        kind: 'real-traffic-recording',
        provider: options.provider,
        wireFamily: options.wireFamily,
        transport: options.transport,
        capture: options.capture,
        turns: structuredClone(turns),
        placeholders,
      };
      return validateFixtureEnvelope(envelope);
    },
    flush: async () => {
      await Promise.resolve();
      return validateFixtureEnvelope({
        schemaVersion: 1,
        kind: 'real-traffic-recording',
        provider: options.provider,
        wireFamily: options.wireFamily,
        transport: options.transport,
        capture: options.capture,
        turns: structuredClone(turns),
        placeholders,
      });
    },
  };
}

export function createRecordingMiddleware(options: {
  recorder: FixtureRecorder;
  onError?: (error: unknown) => void;
}): FetchMiddleware {
  return async (ctx, next) => {
    const bodyText = await requestBody(ctx.url, ctx.init);
    let body: unknown = bodyText || undefined;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        /* retain text */
      }
    }
    const url = ctx.url instanceof URL ? ctx.url : new URL(ctx.url instanceof Request ? ctx.url.url : String(ctx.url));
    options.recorder.recordRequest({
      kind: 'http-request',
      method: ctx.init?.method ?? (ctx.url instanceof Request ? ctx.url.method : 'GET'),
      urlPath: `${url.pathname}${url.search}`,
      headers: sanitizeHeaders(ctx.init?.headers ?? (ctx.url instanceof Request ? ctx.url.headers : undefined)) ?? {},
      body,
    });
    let response: Response;
    try {
      response = await next(ctx);
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
    options.recorder.recordResponseHead({
      kind: 'http-response-head',
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    });
    try {
      const text = await response.clone().text();
      if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
        for (const event of parseSseEvents(text)) options.recorder.recordSseEvent({ kind: 'sse-event', ...event });
      } else if (text) {
        let bodyValue: unknown = text;
        try {
          bodyValue = JSON.parse(text);
        } catch {
          /* retain text */
        }
        options.recorder.recordJsonBody({ kind: 'json-body', body: bodyValue });
      }
    } catch (error) {
      options.onError?.(error);
    }
    return response;
  };
}

export function parseSseEvents(text: string): Array<{ event?: string; data: string }> {
  const result: Array<{ event?: string; data: string }> = [];
  for (const block of text.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trimStart();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (data.length) result.push({ ...(event ? { event } : {}), data: data.join('\n') });
  }
  return result;
}

async function requestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | null> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  if (input instanceof Request)
    try {
      return await input.clone().text();
    } catch {
      return null;
    }
  return null;
}

export function createRecorderCaptureId(): string {
  return randomUUID();
}
