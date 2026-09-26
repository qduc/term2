function applyCacheControlToMessage(msg: any): void {
  if (!msg) return;
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    for (let j = msg.content.length - 1; j >= 0; j--) {
      if (msg.content[j].type === 'text') {
        msg.content[j] = { ...msg.content[j], cache_control: { type: 'ephemeral' } };
        break;
      }
    }
  }
}

export function addCacheControlToLastTwoMessages(messages: any[], modelId?: string): void {
  if (modelId) {
    const lowerModelId = modelId.toLowerCase();
    if (!lowerModelId.includes('anthropic') && !lowerModelId.includes('claude') && !lowerModelId.includes('qwen')) {
      return;
    }
  }

  // 1. Add cache control to the *last* system message only. A breakpoint
  // caches everything up to and including its position, so marking the last
  // system message covers the system prompt + all prior turns in a single
  // breakpoint. Marking every system message instead wastes breakpoints and,
  // once mode-change notices accumulate in history, can exceed the provider's
  // 4-breakpoint cap.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      applyCacheControlToMessage(messages[i]);
      break;
    }
  }

  // 2. Add cache control to last message that has role == 'user'
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      applyCacheControlToMessage(messages[i]);
      break;
    }
  }

  // 3. Add cache control to last message that has role == 'tool'
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') {
      applyCacheControlToMessage(messages[i]);
      break;
    }
  }
}
