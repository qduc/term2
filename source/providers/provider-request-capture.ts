import type { OpenAIRequestPrefixBinding } from './openai-request-prefix-binding.js';

/**
 * Optional Stage 0 instrumentation for recording the exact provider request
 * projection at an established wire seam. It is deliberately observational:
 * callers own storage and the default is no capture.
 */
export type ProviderRequestProjection = {
  provider: 'openai' | 'codex';
  transport: 'http' | 'websocket';
  requestData: Record<string, unknown>;
};

export type ProviderRequestCapture = {
  record(projection: ProviderRequestProjection): void;
  /**
   * Optional OpenAI-private lifecycle seam. It intentionally has no continuity
   * or checkpoint dependency: account identity and prefix binding are not
   * available at this boundary yet.
   */
  observe?(observation: OpenAIRequestLifecycleObservation): void;
};

export type OpenAIRequestLifecycleObservation = {
  token: string;
  provider: 'openai';
  transport: 'http' | 'websocket';
  model: string;
  endpoint: string;
  requestData: Record<string, unknown>;
  phase: 'request-built' | 'terminal' | 'failed' | 'abandoned';
  responseId?: string;
  prefixBinding?: OpenAIRequestPrefixBinding;
};

export const captureProviderRequest = (
  capture: ProviderRequestCapture | undefined,
  projection: ProviderRequestProjection,
): void => {
  try {
    capture?.record({
      ...projection,
      // Captures must remain stable if the private client mutates its request
      // object after this observation point.
      requestData: structuredClone(projection.requestData),
    });
  } catch {
    // Observation must never alter the provider request path.
  }
};

export const observeOpenAIRequestLifecycle = (
  capture: ProviderRequestCapture | undefined,
  observation: OpenAIRequestLifecycleObservation,
): void => {
  try {
    capture?.observe?.({ ...observation, requestData: structuredClone(observation.requestData) });
  } catch {
    // Observation must never alter the provider request path.
  }
};
