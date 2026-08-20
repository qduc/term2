export type OpencodeModelTransport = 'anthropic-messages' | 'openai-chat-completions' | 'openai-responses';

type OpencodeModelTransportRule = {
  transport: Exclude<OpencodeModelTransport, 'openai-chat-completions'>;
  modelIdFragments: readonly string[];
};

// OpenCode serves different model families through different wire protocols.
// Keep exceptional formats explicit and default unrecognized models to its
// OpenAI-compatible Chat Completions endpoint.
const OPENCODE_MODEL_TRANSPORT_RULES: readonly OpencodeModelTransportRule[] = [
  { transport: 'openai-responses', modelIdFragments: ['gpt', 'grok', 'muse-spark'] },
  { transport: 'anthropic-messages', modelIdFragments: ['minimax', 'qwen'] },
];

export function selectOpencodeModelTransport(modelId: string): OpencodeModelTransport {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    OPENCODE_MODEL_TRANSPORT_RULES.find(({ modelIdFragments }) =>
      modelIdFragments.some((fragment) => normalizedModelId.includes(fragment)),
    )?.transport ?? 'openai-chat-completions'
  );
}

export function shouldApplyOpencodeAnthropicPromptCaching(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return (
    normalizedModelId.includes('anthropic') ||
    normalizedModelId.includes('claude') ||
    normalizedModelId.includes('qwen')
  );
}
