// OpenCode serves different model families through different wire protocols.
// Keep exceptional formats explicit and default unrecognized models to its
// OpenAI-compatible Chat Completions endpoint.
const OPENCODE_MODEL_TRANSPORT_RULES = [
    { transport: 'openai-responses', modelIdFragments: ['gpt', 'grok', 'muse-spark'] },
    { transport: 'anthropic-messages', modelIdFragments: ['minimax', 'qwen'] },
];
export function selectOpencodeModelTransport(modelId) {
    return findKnownOpencodeModelTransport(modelId) ?? 'openai-chat-completions';
}
/** Returns only an explicit local rule; callers may safely defer unknown IDs to discovery. */
export function findKnownOpencodeModelTransport(modelId) {
    const normalizedModelId = modelId.trim().toLowerCase();
    return OPENCODE_MODEL_TRANSPORT_RULES.find(({ modelIdFragments }) => modelIdFragments.some((fragment) => normalizedModelId.includes(fragment)))?.transport;
}
export function shouldApplyOpencodeAnthropicPromptCaching(modelId) {
    const normalizedModelId = modelId.trim().toLowerCase();
    return (normalizedModelId.includes('anthropic') ||
        normalizedModelId.includes('claude') ||
        normalizedModelId.includes('qwen'));
}
//# sourceMappingURL=opencode-routing.js.map