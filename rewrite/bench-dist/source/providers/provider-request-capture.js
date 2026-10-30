export const captureProviderRequest = (capture, projection) => {
    try {
        capture?.record({
            ...projection,
            // Captures must remain stable if the private client mutates its request
            // object after this observation point.
            requestData: structuredClone(projection.requestData),
        });
    }
    catch {
        // Observation must never alter the provider request path.
    }
};
export const observeOpenAIRequestLifecycle = (capture, observation) => {
    try {
        capture?.observe?.({ ...observation, requestData: structuredClone(observation.requestData) });
    }
    catch {
        // Observation must never alter the provider request path.
    }
};
//# sourceMappingURL=provider-request-capture.js.map