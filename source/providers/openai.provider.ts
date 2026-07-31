import { Runner, Model, ModelProvider, getCurrentTrace, withTrace } from '@openai/agents';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';
import OpenAI from 'openai';
import { registerProvider } from './registry.js';
import type { ProviderDeps, ProviderFetch } from './registry.js';
import { createProviderFetch } from './fetch/composer.js';
import { RetryingModel } from './retrying-model.js';
import { NULL_SESSION_CONTEXT_SERVICE } from '../services/session/session-context-service.js';
import {
  observeOpenAIRequestLifecycle,
  type OpenAIRequestLifecycleObservation,
  type ProviderRequestCapture,
} from './provider-request-capture.js';
import { consumeOpenAIRequestPrefixBindingWithOutcome } from './openai-request-prefix-binding.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_OPENAI_ENDPOINT = 'https://api.openai.com/v1';

type OpenAIRequestAttempt = Omit<OpenAIRequestLifecycleObservation, 'phase' | 'responseId'>;

const clientEndpoint = (client: any): string => {
  const endpoint = client?.baseURL ?? client?._options?.baseURL;
  if (endpoint instanceof URL) return endpoint.toString().replace(/\/$/, '');
  return typeof endpoint === 'string' && endpoint.length > 0 ? endpoint.replace(/\/$/, '') : DEFAULT_OPENAI_ENDPOINT;
};

/**
 * The SDK invokes its private builder below each public model call. State is
 * keyed by the request object, so separate concurrent requests cannot pair a
 * builder invocation with another request's response. SDK retries that reuse
 * one request object intentionally retain its one public-call token.
 */
abstract class OpenAIRequestLifecycleModel {
  private readonly attempts = new WeakMap<object, OpenAIRequestAttempt>();

  beginAttempt(request: any, transport: 'http' | 'websocket', model: string, client: any): void {
    if (request && typeof request === 'object') {
      this.attempts.set(request, {
        token: randomUUID(),
        provider: 'openai',
        transport,
        model,
        endpoint: clientEndpoint(client),
        requestData: {},
      });
    }
  }

  bindPrefix(request: any, capture?: ProviderRequestCapture): void {
    const attempt = request && typeof request === 'object' ? this.attempts.get(request) : undefined;
    if (!attempt) return;
    try {
      attempt.requestData = { input: structuredClone(request.input) };
      if (!attempt.prefixBinding && !attempt.prefixBindingOutcome) {
        const consumption = consumeOpenAIRequestPrefixBindingWithOutcome(request.input);
        attempt.prefixBinding = consumption.binding;
        attempt.prefixBindingOutcome = consumption.outcome;
      }
      observeOpenAIRequestLifecycle(capture, { ...attempt, phase: 'request-built' });
    } catch {
      // Binding must not affect the SDK request.
    }
  }

  finishAttempt(
    request: any,
    phase: Extract<OpenAIRequestLifecycleObservation['phase'], 'terminal' | 'failed' | 'abandoned'>,
    capture?: ProviderRequestCapture,
    responseId?: string,
  ): void {
    if (!request || typeof request !== 'object') return;
    const attempt = this.attempts.get(request);
    if (!attempt) return;
    this.attempts.delete(request);
    observeOpenAIRequestLifecycle(capture, { ...attempt, phase, ...(responseId ? { responseId } : {}) });
  }
}

export class OpenAIResponsesModelWithPromptCacheKey extends OpenAIResponsesModel {
  private readonly lifecycle = new (class extends OpenAIRequestLifecycleModel {})();

  constructor(client: any, model: string, private readonly requestCapture?: ProviderRequestCapture) {
    super(client, model);
  }

  override async getResponse(request: any): Promise<any> {
    this.lifecycle.beginAttempt(request, 'http', (this as any)._model, (this as any)._client);
    this.lifecycle.bindPrefix(request, this.requestCapture);
    try {
      const response = await super.getResponse(request);
      this.lifecycle.finishAttempt(request, 'terminal', this.requestCapture, response?.responseId);
      return response;
    } catch (error) {
      this.lifecycle.finishAttempt(request, 'failed', this.requestCapture);
      throw error;
    }
  }

  override async *getStreamedResponse(request: any): AsyncIterable<any> {
    this.lifecycle.beginAttempt(request, 'http', (this as any)._model, (this as any)._client);
    this.lifecycle.bindPrefix(request, this.requestCapture);
    let terminal = false;
    try {
      for await (const event of super.getStreamedResponse(request)) {
        if (event?.type === 'response_done') {
          terminal = true;
          this.lifecycle.finishAttempt(request, 'terminal', this.requestCapture, event.response?.id);
        }
        yield event;
      }
    } catch (error) {
      this.lifecycle.finishAttempt(request, 'failed', this.requestCapture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finishAttempt(request, 'abandoned', this.requestCapture);
    }
  }
}

export class OpenAIResponsesWSModelWithPromptCacheKey extends OpenAIResponsesWSModel {
  private readonly lifecycle = new (class extends OpenAIRequestLifecycleModel {})();

  constructor(client: any, model: string, private readonly requestCapture?: ProviderRequestCapture) {
    super(client, model);
  }

  override async getResponse(request: any): Promise<any> {
    this.lifecycle.beginAttempt(request, 'websocket', (this as any)._model, (this as any)._client);
    this.lifecycle.bindPrefix(request, this.requestCapture);
    const currentTrace = getCurrentTrace();
    try {
      const response = currentTrace
        ? await super.getResponse(request)
        : await withTrace('openai-responses-ws-model-trace', () => super.getResponse(request));
      this.lifecycle.finishAttempt(request, 'terminal', this.requestCapture, response?.responseId);
      return response;
    } catch (error) {
      this.lifecycle.finishAttempt(request, 'failed', this.requestCapture);
      throw error;
    }
  }

  override async *getStreamedResponse(request: any): AsyncIterable<any> {
    this.lifecycle.beginAttempt(request, 'websocket', (this as any)._model, (this as any)._client);
    this.lifecycle.bindPrefix(request, this.requestCapture);
    let terminal = false;
    try {
      for await (const event of super.getStreamedResponse(request)) {
        if (event?.type === 'response_done') {
          terminal = true;
          this.lifecycle.finishAttempt(request, 'terminal', this.requestCapture, event.response?.id);
        }
        yield event;
      }
    } catch (error) {
      this.lifecycle.finishAttempt(request, 'failed', this.requestCapture);
      throw error;
    } finally {
      if (!terminal) this.lifecycle.finishAttempt(request, 'abandoned', this.requestCapture);
    }
  }
}

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';

async function fetchOpenAIModels(
  deps: ProviderDeps,
  fetchImpl: ProviderFetch = fetch as any,
): Promise<Array<{ id: string; name?: string }>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = deps.settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchImpl(OPENAI_MODELS_URL, { headers });
  if (!response.ok) {
    throw new Error(`OpenAI models request failed (${response.status})`);
  }

  const body = await response.json();
  const raw = body?.data || [];

  if (!Array.isArray(raw)) return [];

  return raw
    .map((item: any) => {
      const id = item?.id || item?.model || '';
      const name = item?.name || item?.display_name || item?.description;
      return id ? { id, name } : null;
    })
    .filter(Boolean)
    .reverse() as Array<{ id: string; name?: string }>;
}

class OpenAIProvider implements ModelProvider {
  private readonly models = new Map<string, RetryingModel>();

  constructor(
    private readonly openAIClient: OpenAI,
    private readonly loggingService: any,
    private readonly transport: 'websocket' | 'http',
    private readonly retryAttempts: number,
    private readonly onRetry?: () => void,
    private readonly requestCapture?: ProviderRequestCapture,
  ) {}

  getModel(modelName?: string): Model {
    const model = modelName || 'gpt-4o';
    const cached = this.models.get(model);
    if (cached) {
      return cached;
    }

    const selectedModel =
      this.transport === 'http'
        ? new OpenAIResponsesModelWithPromptCacheKey(this.openAIClient as any, model, this.requestCapture)
        : new OpenAIResponsesWSModelWithPromptCacheKey(this.openAIClient as any, model, this.requestCapture);
    const retryingModel = new RetryingModel(selectedModel, {
      retryAttempts: this.retryAttempts,
      loggingService: this.loggingService,
      onRetry: this.onRetry,
    });

    this.models.set(model, retryingModel);
    return retryingModel;
  }

  async close(): Promise<void> {
    for (const model of this.models.values()) {
      await model.close();
    }
    this.models.clear();
  }
}

// Register OpenAI provider
registerProvider({
  id: 'openai',
  label: 'OpenAI',
  createRunner: ({ settingsService, loggingService, sessionContextService, onRetry, requestCapture }) => {
    const defaultModel = settingsService.get('agent.model') || 'gpt-4o';
    const apiKey = settingsService.get('agent.openai.apiKey') || process.env.OPENAI_API_KEY;
    const openAIClient = new OpenAI({
      apiKey: apiKey || 'placeholder',
      maxRetries: settingsService.get('agent.retryAttempts') ?? 2,
      fetch: createProviderFetch({
        providerId: 'openai',
        defaultModel,
        deps: { loggingService, sessionContextService: sessionContextService ?? NULL_SESSION_CONTEXT_SERVICE },
      }) as any,
    });

    return new Runner({
      modelProvider: new OpenAIProvider(
        openAIClient,
        loggingService,
        settingsService.get('agent.transport') ?? 'websocket',
        settingsService.get('agent.retryAttempts') ?? 2,
        onRetry,
        requestCapture,
      ),
    });
  },
  fetchModels: fetchOpenAIModels,
  clearConversations: undefined, // No conversation state to clear
  sensitiveSettingKeys: [],
  capabilities: {
    supportsConversationChaining: true,
    supportsTracingControl: true,
    supportsPromptCacheKey: true,
    usesStrictToolSchema: true,
    nativePatchModelPrefixes: ['gpt-5.1'],
  },
});
