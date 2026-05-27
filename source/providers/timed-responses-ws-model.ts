import { Model, ModelRequest, ModelResponse, getCurrentTrace, withTrace } from '@openai/agents-core';
import { OpenAIResponsesModel } from '@openai/agents-openai';
import { TimedWsConnection, WebSocketFactory } from './timed-ws-connection.js';
import WebSocket from 'ws';

export type TimedWsOptions = {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  reuseConnection?: boolean;
};

type PreparedWebSocketRequest = {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  identity: string;
};

export class TimedResponsesWSModel extends OpenAIResponsesModel implements Model {
  private connection: TimedWsConnection | null = null;
  private connectionPromise: Promise<TimedWsConnection> | null = null;
  private connectionIdentity: string | null = null;
  private connectionPromiseIdentity: string | null = null;

  constructor(
    client: any,
    model: string,
    private readonly options: TimedWsOptions,
    private readonly wsFactory: WebSocketFactory = (url, opts) => new WebSocket(url, opts as any),
  ) {
    super(client, model);
  }

  private async getConnection(request: PreparedWebSocketRequest): Promise<TimedWsConnection> {
    if (this.connection && this.options.reuseConnection !== false && this.connectionIdentity === request.identity) {
      return this.connection;
    }

    if (this.connectionPromise) {
      if (this.connectionPromiseIdentity === request.identity && this.options.reuseConnection !== false) {
        return this.connectionPromise;
      }

      await this.connectionPromise.catch(() => undefined);
    }

    if (this.connection && (this.options.reuseConnection === false || this.connectionIdentity !== request.identity)) {
      await this.connection.close();
      this.connection = null;
      this.connectionIdentity = null;
    }

    this.connectionPromiseIdentity = request.identity;
    this.connectionPromise = this.createConnection(request);

    try {
      this.connection = await this.connectionPromise;
      this.connectionIdentity = request.identity;
      return this.connection;
    } finally {
      this.connectionPromise = null;
      this.connectionPromiseIdentity = null;
    }
  }

  private async createConnection(request: PreparedWebSocketRequest): Promise<TimedWsConnection> {
    return await TimedWsConnection.connect(request.url, request.headers, this.options, request.signal, this.wsFactory);
  }

  private buildWebSocketUrl(built: any): string {
    const baseURL = this._client.baseURL || 'https://api.openai.com';
    const url = new URL(baseURL);

    if (url.protocol === 'https:') {
      url.protocol = 'wss:';
    } else if (url.protocol === 'http:') {
      url.protocol = 'ws:';
    }

    url.pathname = ensureResponsesWebSocketPath(url.pathname);
    mergeQueryParamsIntoURL(url, (this._client as any)._options?.defaultQuery);
    mergeQueryParamsIntoURL(url, built.transportExtraQuery);

    return url.toString();
  }

  private async buildHeaders(
    websocketURL: string,
    signal?: AbortSignal,
    extraHeaders?: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const client = this._client as any;
    const url = new URL(websocketURL);
    const authQuery = searchParamsToAuthHeaderQuery(url.searchParams);

    // Get auth headers from the client
    if (typeof client.authHeaders === 'function') {
      const authHeaders = await this.withAbort(
        Promise.resolve().then(() =>
          client.authHeaders({
            method: 'get',
            path: url.pathname,
            ...(authQuery ? { query: authQuery } : {}),
          }),
        ),
        signal,
      );
      if (authHeaders) {
        mergeHeadersIntoRecord(headers, authHeaders);
      }
    }

    // Fallback to API key if authHeaders not available
    if (!headers.Authorization && !headers.authorization) {
      if (typeof client.apiKey === 'string' && client.apiKey !== 'Missing Key') {
        headers['Authorization'] = `Bearer ${client.apiKey}`;
      }
    }

    if (client.organization) {
      headers['OpenAI-Organization'] = client.organization;
    }

    if (client.project) {
      headers['OpenAI-Project'] = client.project;
    }

    // Add default headers from client options
    if (client._options?.defaultHeaders) {
      mergeHeadersIntoRecord(headers, client._options.defaultHeaders);
    }

    if (extraHeaders) {
      mergeHeadersIntoRecord(headers, extraHeaders);
    }

    return headers;
  }

  override async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const currentTrace = getCurrentTrace();
    if (currentTrace) {
      return super.getResponse(request);
    }
    return withTrace('timed-responses-ws-model-trace', () => super.getResponse(request));
  }

  protected override async _fetchResponse(request: ModelRequest, stream: boolean): Promise<any> {
    const built = this._buildResponsesCreateRequest(request, true);
    const websocketURL = this.buildWebSocketUrl(built);
    const headers = await this.buildHeaders(websocketURL, built.signal, built.transportExtraHeaders);
    const connectionRequest: PreparedWebSocketRequest = {
      url: websocketURL,
      headers,
      signal: built.signal,
      identity: this.getConnectionIdentity(websocketURL, headers),
    };

    const requestPayload = {
      type: 'response.create',
      response: built.requestData,
    };

    const connection = await this.getConnection(connectionRequest);
    connection.send(JSON.stringify(requestPayload));

    if (stream) {
      return this.iterWebSocketEvents(connection, built.signal);
    }

    let finalResponse: any = null;
    try {
      for await (const event of this.iterWebSocketEvents(connection, built.signal)) {
        if (this.isTerminalEvent(event)) {
          finalResponse = event.response;
        }
      }
    } catch (error) {
      throw error;
    }

    if (!finalResponse) {
      throw new Error('Responses websocket stream ended without a terminal response event.');
    }
    return finalResponse;
  }

  private async *iterWebSocketEvents(
    connection: TimedWsConnection,
    signal?: AbortSignal,
  ): AsyncGenerator<any, void, unknown> {
    try {
      while (true) {
        const frame = await connection.nextFrame(signal);
        if (frame === null) {
          this.connection = null;
          this.connectionIdentity = null;
          throw new Error('WebSocket connection closed before response completed');
        }

        const event = JSON.parse(frame);
        yield event;

        if (this.isTerminalEvent(event)) {
          if (event.type === 'response.failed' || event.type === 'response.error') {
            throw new Error(event.response?.error?.message || 'Response failed');
          }
          return;
        }
      }
    } catch (error) {
      this.connection = null;
      this.connectionIdentity = null;
      throw error;
    } finally {
      if (this.options.reuseConnection === false) {
        try {
          await connection.close();
        } finally {
          if (this.connection === connection) {
            this.connection = null;
            this.connectionIdentity = null;
          }
        }
      }
    }
  }

  private isTerminalEvent(event: any): boolean {
    return (
      event.type === 'response.completed' ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete' ||
      event.type === 'response.error'
    );
  }

  override getRetryAdvice(args: any): any {
    const err = args.error;
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('open timed out') ||
        msg.includes('closed before opening') ||
        msg.includes('timed out before opening') ||
        msg.includes('connection timed out') ||
        msg.includes('aborted')
      ) {
        return {
          suggested: true,
          replaySafety: 'safe',
          reason: err.message,
        };
      }
      if (msg.includes('idle timeout') || msg.includes('closed before response completed')) {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          reason: err.message,
        };
      }
    }
    return super.getRetryAdvice(args);
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.connectionIdentity = null;
    }
  }

  private getConnectionIdentity(url: string, headers: Record<string, string>): string {
    const normalizedHeaders = Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value])
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        `${leftKey}:${leftValue}`.localeCompare(`${rightKey}:${rightValue}`),
      );

    return JSON.stringify([url, normalizedHeaders]);
  }

  private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
      return await promise;
    }

    if (signal.aborted) {
      throw new Error('Aborted');
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new Error('Aborted'));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureResponsesWebSocketPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/, '');
  if (normalizedPath === '/responses' || normalizedPath.endsWith('/responses')) {
    return normalizedPath;
  }
  return `${normalizedPath}/responses`;
}

function mergeQueryParamsIntoURL(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) {
    return;
  }

  for (const [key, rawValue] of Object.entries(query)) {
    if (typeof rawValue === 'undefined') {
      continue;
    }

    for (const existingKey of Array.from(url.searchParams.keys())) {
      if (existingKey === key || existingKey.startsWith(`${key}[`)) {
        url.searchParams.delete(existingKey);
      }
    }

    if (rawValue === null) {
      continue;
    }

    appendQueryParamValue(url, key, rawValue);
  }
}

function appendQueryParamValue(url: URL, key: string, rawValue: unknown): void {
  if (typeof rawValue === 'undefined' || rawValue === null) {
    return;
  }

  if (Array.isArray(rawValue)) {
    for (const value of rawValue) {
      appendQueryParamValue(url, `${key}[]`, value);
    }
    return;
  }

  if (isRecordLike(rawValue)) {
    for (const [nestedKey, nestedValue] of Object.entries(rawValue)) {
      appendQueryParamValue(url, `${key}[${nestedKey}]`, nestedValue);
    }
    return;
  }

  if (rawValue instanceof Date) {
    url.searchParams.append(key, rawValue.toISOString());
    return;
  }

  url.searchParams.append(key, String(rawValue));
}

function searchParamsToAuthHeaderQuery(searchParams: URLSearchParams): Record<string, string | string[]> | undefined {
  const query: Record<string, string | string[]> = {};
  let hasEntries = false;

  for (const [key, value] of searchParams.entries()) {
    hasEntries = true;

    const existingValue = query[key];
    if (typeof existingValue === 'undefined') {
      query[key] = value;
      continue;
    }

    if (Array.isArray(existingValue)) {
      existingValue.push(value);
      continue;
    }

    query[key] = [existingValue, value];
  }

  return hasEntries ? query : undefined;
}

function mergeHeadersIntoRecord(
  target: Record<string, string>,
  headers: Record<string, unknown> | null | undefined,
): void {
  if (!headers) {
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined' || value === null) {
      continue;
    }

    target[key] = String(value);
  }
}
