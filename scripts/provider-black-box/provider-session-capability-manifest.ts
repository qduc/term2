import type { CapabilityExecution } from './provider-capability-matrix.js';

/**
 * Side-effect-free Gate C manifest. The lifecycle files re-export these
 * ledgers, while accounting tests can consume them without registering their
 * Vitest suites or starting fixture servers.
 */
/**
 * Boundary-audit semantic assertions attached to lifecycle executions below.
 * Keeping these in the same manifest prevents a disconnected provider harness.
 */
export const BOUNDARY_AUDIT_CAPABILITY_EVIDENCE = [
  { rowId: 'codex-http', scenarioId: 'codex-http.two-user-turn', fields: ['prompt_cache_key', 'include'] },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.two-user-turn', fields: ['prompt_cache_key', 'include'] },
] as const;

export const RESPONSES_CAPABILITY_EXECUTIONS = [
  { rowId: 'openai-http', scenarioId: 'openai-http.two-user-turn' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.two-user-turn' },
  { rowId: 'codex-http', scenarioId: 'codex-http.two-user-turn' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.two-user-turn' },
  { rowId: 'openai-http', scenarioId: 'openai-http.approval-approve' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.approval-approve' },
  { rowId: 'codex-http', scenarioId: 'codex-http.approval-approve' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.approval-approve' },
  { rowId: 'openai-http', scenarioId: 'openai-http.approval-reject' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.approval-reject' },
  { rowId: 'codex-http', scenarioId: 'codex-http.approval-reject' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.approval-reject' },
  { rowId: 'openai-http', scenarioId: 'openai-http.native-error' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.native-error' },
  { rowId: 'codex-http', scenarioId: 'codex-http.native-error' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.native-error' },
  { rowId: 'openai-http', scenarioId: 'openai-http.incomplete-stream' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.incomplete-stream' },
  { rowId: 'codex-http', scenarioId: 'codex-http.incomplete-stream' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.incomplete-stream' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.abnormal-close' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.abnormal-close' },
] as const satisfies readonly CapabilityExecution[];

export const STATELESS_CAPABILITY_EXECUTIONS = [
  { rowId: 'openrouter-http', scenarioId: 'openrouter-http.two-user-turn' },
  { rowId: 'openrouter-http', scenarioId: 'openrouter-http.approval-approve' },
  { rowId: 'openrouter-http', scenarioId: 'openrouter-http.approval-reject' },
  { rowId: 'runtime-openai-chat', scenarioId: 'runtime-openai-chat.two-user-turn' },
  { rowId: 'runtime-openai-chat', scenarioId: 'runtime-openai-chat.approval-approve' },
  { rowId: 'runtime-openai-chat', scenarioId: 'runtime-openai-chat.approval-reject' },
  { rowId: 'runtime-openai-compatible-chat', scenarioId: 'runtime-openai-compatible-chat.two-user-turn' },
  { rowId: 'runtime-openai-compatible-chat', scenarioId: 'runtime-openai-compatible-chat.approval-approve' },
  { rowId: 'runtime-openai-compatible-chat', scenarioId: 'runtime-openai-compatible-chat.approval-reject' },
  { rowId: 'runtime-llama-cpp-chat', scenarioId: 'runtime-llama-cpp-chat.two-user-turn' },
  { rowId: 'runtime-llama-cpp-chat', scenarioId: 'runtime-llama-cpp-chat.approval-approve' },
  { rowId: 'runtime-llama-cpp-chat', scenarioId: 'runtime-llama-cpp-chat.approval-reject' },
  { rowId: 'runtime-anthropic-messages', scenarioId: 'runtime-anthropic-messages.two-user-turn' },
  { rowId: 'runtime-anthropic-messages', scenarioId: 'runtime-anthropic-messages.approval-approve' },
  { rowId: 'runtime-anthropic-messages', scenarioId: 'runtime-anthropic-messages.approval-reject' },
  { rowId: 'runtime-google-generate-content', scenarioId: 'runtime-google-generate-content.two-user-turn' },
  { rowId: 'runtime-google-generate-content', scenarioId: 'runtime-google-generate-content.approval-approve' },
  { rowId: 'runtime-google-generate-content', scenarioId: 'runtime-google-generate-content.approval-reject' },
  { rowId: 'opencode-chat-completions', scenarioId: 'opencode-chat-completions.two-user-turn' },
  { rowId: 'opencode-chat-completions', scenarioId: 'opencode-chat-completions.approval-approve' },
  { rowId: 'opencode-chat-completions', scenarioId: 'opencode-chat-completions.approval-reject' },
  { rowId: 'opencode-anthropic-messages', scenarioId: 'opencode-anthropic-messages.two-user-turn' },
  { rowId: 'opencode-anthropic-messages', scenarioId: 'opencode-anthropic-messages.approval-approve' },
  { rowId: 'opencode-anthropic-messages', scenarioId: 'opencode-anthropic-messages.approval-reject' },
] as const satisfies readonly CapabilityExecution[];

export const RESILIENCE_CAPABILITY_EXECUTIONS = [
  { rowId: 'openai-http', scenarioId: 'openai-http.native-error' },
  { rowId: 'openai-http', scenarioId: 'openai-http.incomplete-stream' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.native-error' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.incomplete-stream' },
  { rowId: 'openai-websocket', scenarioId: 'openai-websocket.abnormal-close' },
  { rowId: 'codex-http', scenarioId: 'codex-http.native-error' },
  { rowId: 'codex-http', scenarioId: 'codex-http.incomplete-stream' },
  { rowId: 'openrouter-http', scenarioId: 'openrouter-http.native-error' },
  { rowId: 'openrouter-http', scenarioId: 'openrouter-http.incomplete-stream' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.native-error' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.incomplete-stream' },
  { rowId: 'codex-websocket', scenarioId: 'codex-websocket.abnormal-close' },
  { rowId: 'runtime-openai-compatible-chat', scenarioId: 'runtime-openai-compatible-chat.native-error' },
  { rowId: 'runtime-openai-compatible-chat', scenarioId: 'runtime-openai-compatible-chat.incomplete-stream' },
  { rowId: 'runtime-anthropic-messages', scenarioId: 'runtime-anthropic-messages.native-error' },
  { rowId: 'runtime-anthropic-messages', scenarioId: 'runtime-anthropic-messages.incomplete-stream' },
  { rowId: 'runtime-google-generate-content', scenarioId: 'runtime-google-generate-content.native-error' },
  { rowId: 'runtime-google-generate-content', scenarioId: 'runtime-google-generate-content.incomplete-stream' },
] as const satisfies readonly CapabilityExecution[];

export const ALL_PROVIDER_SESSION_CAPABILITY_EXECUTIONS = [
  ...RESPONSES_CAPABILITY_EXECUTIONS,
  ...STATELESS_CAPABILITY_EXECUTIONS,
  ...RESILIENCE_CAPABILITY_EXECUTIONS,
] as const satisfies readonly CapabilityExecution[];
