/**
 * Root-owned, resolved OpenAI provider identity shared by lifecycle observation
 * and selector-parity assessment. It contains no credentials or request data.
 */
export class OpenAIRootProviderIdentity {
    #identity = null;
    get current() {
        return this.#identity;
    }
    observe(identity) {
        if (!identity.provider || !identity.endpoint || !identity.model)
            return;
        this.#identity = Object.freeze({ ...identity });
    }
}
//# sourceMappingURL=openai-root-provider-identity.js.map