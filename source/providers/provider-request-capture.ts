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
};

export const captureProviderRequest = (
  capture: ProviderRequestCapture | undefined,
  projection: ProviderRequestProjection,
): void => {
  capture?.record({
    ...projection,
    // Captures must remain stable if the private client mutates its request
    // object after this observation point.
    requestData: structuredClone(projection.requestData),
  });
};
