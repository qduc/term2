/** Request-owned, observational OpenAI lifecycle state. */
import { randomUUID } from 'node:crypto';
import type { StreamedModelTurnRequest } from '../../streamed-model-turn.js';
import {
  observeOpenAIRequestLifecycle,
  type OpenAIRequestLifecycleObservation,
  type ProviderRequestCapture,
} from '../provider-request-capture.js';

const endpointOf = (client: any): string => {
  const value = client?.baseURL ?? client?._options?.baseURL;
  return typeof value === 'string' && value ? value.replace(/\/$/, '') : 'https://api.openai.com/v1';
};

type Attempt = Omit<OpenAIRequestLifecycleObservation, 'phase' | 'responseId'>;

export class OpenAIRequestLifecycle {
  #attempts = new WeakMap<object, Attempt>();

  begin(request: StreamedModelTurnRequest, transport: 'http' | 'websocket', model: string, client: any): void {
    this.#attempts.set(request as object, {
      token: randomUUID(),
      provider: 'openai',
      transport,
      model,
      endpoint: endpointOf(client),
      requestData: {},
    });
  }

  bind(request: StreamedModelTurnRequest, capture?: ProviderRequestCapture): void {
    const attempt = this.#attempts.get(request as object);
    if (!attempt) return;
    try {
      attempt.requestData = { input: structuredClone(request.input) };
      // There is no production prefix-binding producer. Keep its existing
      // observational outcome without an ambient process-wide scope.
      attempt.prefixBindingOutcome = 'not_prepared';
      observeOpenAIRequestLifecycle(capture, { ...attempt, phase: 'request-built' });
    } catch {
      /* lifecycle observation is non-authoritative */
    }
  }

  finish(
    request: StreamedModelTurnRequest,
    phase: 'terminal' | 'failed' | 'abandoned',
    capture?: ProviderRequestCapture,
    responseId?: string,
  ): void {
    const attempt = this.#attempts.get(request as object);
    if (!attempt) return;
    this.#attempts.delete(request as object);
    observeOpenAIRequestLifecycle(capture, { ...attempt, phase, ...(responseId ? { responseId } : {}) });
  }
}
