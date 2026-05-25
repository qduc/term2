export function applyLlamaCppReasoningControls(target: Record<string, any>, reasoningEffort: string | undefined): void {
  const budgets: Record<string, number> = {
    low: 1024,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
  };

  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    target.chat_template_kwargs = {
      reasoning_effort: 'low',
      enable_thinking: false,
      thinking_mode: 'disabled',
      reasoning_budget: 0,
    };
    return;
  }

  const templateEffort = reasoningEffort === 'xhigh' ? 'high' : reasoningEffort || 'medium';
  target.chat_template_kwargs = {
    reasoning_effort: templateEffort,
    enable_thinking: true,
    thinking_mode: templateEffort,
    reasoning_budget: budgets[reasoningEffort || 'medium'] ?? budgets.medium,
  };
}

export function applyLlamaCppRequestTransform(body: Record<string, any>, providerType: string): boolean {
  const reasoningEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined;
  if (providerType !== 'llama.cpp' || !reasoningEffort) {
    return false;
  }

  delete body.reasoning_effort;
  applyLlamaCppReasoningControls(body, reasoningEffort);
  return true;
}
