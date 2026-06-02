export type OpencodeModelTransport = 'anthropic-messages' | 'openai-chat-completions';

const ANTHROPIC_FORMAT_MODEL_FRAGMENTS = ['minimax', 'qwen'];

export function selectOpencodeModelTransport(modelId: string): OpencodeModelTransport {
  const normalizedModelId = modelId.toLowerCase();
  return ANTHROPIC_FORMAT_MODEL_FRAGMENTS.some((fragment) => normalizedModelId.includes(fragment))
    ? 'anthropic-messages'
    : 'openai-chat-completions';
}

export function shouldApplyOpencodeAnthropicPromptCaching(modelId: string): boolean {
  const normalizedModelId = modelId.toLowerCase();
  return (
    normalizedModelId.includes('anthropic') ||
    normalizedModelId.includes('claude') ||
    normalizedModelId.includes('qwen')
  );
}
