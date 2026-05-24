import { randomUUID } from 'node:crypto';
import { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { describeError } from '../utils/error-helpers.js';
import { summarizeReceivedTraffic } from '../services/provider-traffic.js';

export interface FallbackState {
  isDowngraded: boolean;
}

export function isNetworkProtocolError(err: any): boolean {
  if (!err) return false;

  // Check standard Node.js system error codes
  if (typeof err.code === 'string') {
    const code = err.code.toUpperCase();
    if (
      code === 'ENOTFOUND' ||
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'EPIPE' ||
      code === 'ECONNRESET' ||
      code === 'EHOSTUNREACH' ||
      code === 'ENETUNREACH'
    ) {
      return true;
    }
  }

  const message = (err.message || '').toLowerCase();

  // Exclude auth errors and rate limits (401, 403, 429) explicitly
  if (
    message.includes('unexpected server response: 401') ||
    message.includes('unexpected server response: 403') ||
    message.includes('unexpected server response: 429')
  ) {
    return false;
  }

  const unexpectedServerResponseMatch = message.match(/unexpected server response:\s*(\d{3})/);
  if (unexpectedServerResponseMatch) {
    const status = Number(unexpectedServerResponseMatch[1]);
    return status === 502 || status === 503 || status === 504;
  }

  // WebSocket transport specific and generic connection error signatures
  if (
    message.includes('websocket connection closed') ||
    message.includes('websocket is not open') ||
    message.includes('socket hang up') ||
    message.includes('pong timeout') ||
    message.includes('unexpected server response:') || // e.g. unexpected server response: 502/503
    message.includes('failed to open') ||
    message.includes('connection error') ||
    message.includes('connection failed')
  ) {
    return true;
  }

  if (err.name === 'InvalidStateError') {
    return true;
  }

  // Inspect the cause recursively if available
  if (err.cause && isNetworkProtocolError(err.cause)) {
    return true;
  }

  return false;
}

export class FallbackResponsesModel implements Model {
  constructor(
    private readonly wsModel: Model,
    private readonly httpModel: Model,
    private readonly state: FallbackState,
    private readonly onDowngrade?: (error: unknown) => void,
    private readonly loggingService?: any,
    private readonly providerId?: string,
  ) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    if (this.state.isDowngraded) {
      return this.httpModel.getResponse(request);
    }

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const trafficContext = this.loggingService?.getTrafficContext?.() ?? null;
    const baseMeta = {
      requestId,
      traceId: trafficContext?.traceId ?? this.loggingService?.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider: this.providerId || 'unknown',
      model,
    };

    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    // Log request start
    if (this.loggingService && this.providerId) {
      let sentBody: any = request;
      try {
        if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
          const built = (this.wsModel as any)._buildResponsesCreateRequest(request, false);
          sentBody = built.requestData;
        }
      } catch {
        // fallback
      }

      this.loggingService.debug(`${this.providerId} ws request start`, {
        eventType: `${eventPrefix}.request.started`,
        category: 'provider',
        phase: 'request_start',
        direction: 'sent',
        ...baseMeta,
        messageCount: Array.isArray(sentBody?.messages) ? sentBody.messages.length : undefined,
        messages: sentBody?.messages,
        toolsCount: Array.isArray(sentBody?.tools) ? sentBody.tools.length : undefined,
        payload: sentBody,
      });
    }

    try {
      const response = await this.wsModel.getResponse(request);

      // Log response complete
      if (this.loggingService && this.providerId) {
        const summary = {
          transport: 'json' as const,
          status: 200,
          errorFrames: [],
          malformedFrames: [],
          unknownFrames: [],
          payload: response.providerData || response,
        };

        this.loggingService.debug(`${this.providerId} ws response received`, {
          eventType: `${eventPrefix}.response.received`,
          category: 'provider',
          phase: 'provider_response',
          direction: 'received',
          ...baseMeta,
          status: 200,
          text: response.output?.[0]?.type === 'message' ? (response.output[0] as any).content?.[0]?.text : undefined,
          payload: summary,
        });
      }

      return response;
    } catch (error) {
      if (isNetworkProtocolError(error)) {
        if (this.loggingService && this.providerId) {
          this.loggingService.error(`${this.providerId} ws request failed`, {
            eventType: 'provider.response.failed',
            category: 'provider',
            phase: 'provider_response',
            ...baseMeta,
            error: describeError(error),
          });
        }

        this.state.isDowngraded = true;
        if (this.onDowngrade) {
          this.onDowngrade(error);
        }
        return await this.httpModel.getResponse(request);
      }
      throw error;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (this.state.isDowngraded) {
      yield* this.httpModel.getStreamedResponse(request);
      return;
    }

    const requestId = randomUUID();
    const model = request.modelSettings?.providerData?.model || (this.wsModel as any)._model || 'unknown';
    const trafficContext = this.loggingService?.getTrafficContext?.() ?? null;
    const baseMeta = {
      requestId,
      traceId: trafficContext?.traceId ?? this.loggingService?.getCorrelationId?.(),
      sessionId: trafficContext?.sessionId,
      sessionStartedAt: trafficContext?.sessionStartedAt,
      firstUserMessagePreview: trafficContext?.firstUserMessagePreview,
      mode: trafficContext?.mode,
      provider: this.providerId || 'unknown',
      model,
    };

    const isEvaluator = trafficContext?.evaluator === true;
    const eventPrefix = isEvaluator ? 'evaluator' : 'provider';

    // Log request start
    if (this.loggingService && this.providerId) {
      let sentBody: any = request;
      try {
        if (typeof (this.wsModel as any)._buildResponsesCreateRequest === 'function') {
          const built = (this.wsModel as any)._buildResponsesCreateRequest(request, true);
          sentBody = built.requestData;
        }
      } catch {
        // fallback
      }

      this.loggingService.debug(`${this.providerId} ws stream request start`, {
        eventType: `${eventPrefix}.request.started`,
        category: 'provider',
        phase: 'request_start',
        direction: 'sent',
        ...baseMeta,
        messageCount: Array.isArray(sentBody?.messages) ? sentBody.messages.length : undefined,
        messages: sentBody?.messages,
        toolsCount: Array.isArray(sentBody?.tools) ? sentBody.tools.length : undefined,
        payload: sentBody,
      });
    }

    let started = false;
    const sseEvents: any[] = [];
    try {
      const stream = this.wsModel.getStreamedResponse(request);
      for await (const event of stream) {
        if (event.type === 'model' && event.event) {
          sseEvents.push(event.event);
        }
        started = true;
        yield event;
      }

      // Log response complete
      if (this.loggingService && this.providerId && sseEvents.length > 0) {
        const sseText = sseEvents.map((ev) => `data: ${JSON.stringify(ev)}`).join('\n\n');

        const fakeResponse = new Response(sseText, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });

        const summary = await summarizeReceivedTraffic(fakeResponse);
        const summaryPayload = summary.payload as any;
        const responseText = summaryPayload?.choices?.[0]?.delta?.content;
        const toolCalls = summaryPayload?.choices?.[0]?.delta?.tool_calls;

        this.loggingService.debug(`${this.providerId} ws stream response received`, {
          eventType: `${eventPrefix}.response.received`,
          category: 'provider',
          phase: 'provider_response',
          direction: 'received',
          ...baseMeta,
          status: 200,
          text: responseText,
          toolCalls,
          payload: summary,
        });
      }
    } catch (error) {
      if (isNetworkProtocolError(error)) {
        if (this.loggingService && this.providerId) {
          this.loggingService.error(`${this.providerId} ws stream request failed`, {
            eventType: 'provider.response.failed',
            category: 'provider',
            phase: 'provider_response',
            ...baseMeta,
            error: describeError(error),
          });
        }

        this.state.isDowngraded = true;
        if (this.onDowngrade) {
          this.onDowngrade(error);
        }
        if (!started) {
          // Seamless fallback: no events yielded yet
          yield* this.httpModel.getStreamedResponse(request);
          return;
        }
      }
      throw error;
    }
  }

  getRetryAdvice(args: any): any {
    const activeModel = this.state.isDowngraded ? this.httpModel : this.wsModel;
    if (typeof activeModel.getRetryAdvice === 'function') {
      return activeModel.getRetryAdvice(args);
    }
    return undefined;
  }

  get _client(): any {
    return (this.wsModel as any)._client ?? (this.httpModel as any)._client;
  }

  async close(): Promise<void> {
    if (typeof (this.wsModel as any).close === 'function') {
      await (this.wsModel as any).close();
    }
    if (typeof (this.httpModel as any).close === 'function') {
      await (this.httpModel as any).close();
    }
  }
}
