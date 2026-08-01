export type CapabilityTransport = 'http-sse' | 'websocket';
export type CapabilityChainingMode = 'server-managed' | 'stateless';
export type CapabilityWireFamily =
  | 'openai-responses'
  | 'codex-responses'
  | 'ai-sdk-chat'
  | 'chat-completions'
  | 'anthropic-messages'
  | 'google-generate-content';

export type CapabilityRoute = {
  kind: 'built-in' | 'runtime';
  providerId: string;
  runtimeType?: string;
};

export type CapabilityExclusion = {
  reason: string;
  evidence: string;
};

export type ProviderCapability = {
  id: string;
  label: string;
  registryRoute: CapabilityRoute;
  wireFamily: CapabilityWireFamily;
  transport: CapabilityTransport;
  chainingMode: CapabilityChainingMode;
  toolSupport: {
    supportsTools: boolean;
    supportsApproval: boolean;
  };
  reasoningSupport: 'native' | 'provider-dependent' | 'none';
  nativeContinuationField: string | null;
  requiredScenarios: readonly string[];
  exclusion?: CapabilityExclusion;
};

export type CapabilityExecution = {
  rowId: string;
  scenarioId: string;
};

export type CapabilityAccounting = {
  accounted: readonly string[];
  unaccounted: readonly string[];
  invalidExecutions: readonly string[];
};

const REQUIRED_SCENARIO_SUFFIXES = [
  'two-user-turn',
  'approval-approve',
  'approval-reject',
  'native-error',
  'incomplete-stream',
  'abnormal-close',
] as const;

function requiredScenarios(rowId: string): readonly string[] {
  return REQUIRED_SCENARIO_SUFFIXES.map((suffix) => `${rowId}.${suffix}`);
}

/**
 * Test-owned completeness checklist. Keep routing in the row even when two
 * rows share a wire family: runtime registration and lifecycle state are part
 * of the coverage claim.
 */
export const PROVIDER_CAPABILITY_MATRIX: readonly ProviderCapability[] = [
  {
    id: 'openai-http',
    label: 'Built-in OpenAI, HTTP',
    registryRoute: { kind: 'built-in', providerId: 'openai' },
    wireFamily: 'openai-responses',
    transport: 'http-sse',
    chainingMode: 'server-managed',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: 'previous_response_id',
    requiredScenarios: requiredScenarios('openai-http'),
  },
  {
    id: 'openai-websocket',
    label: 'Built-in OpenAI, WebSocket',
    registryRoute: { kind: 'built-in', providerId: 'openai' },
    wireFamily: 'openai-responses',
    transport: 'websocket',
    chainingMode: 'server-managed',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: 'previous_response_id',
    requiredScenarios: requiredScenarios('openai-websocket'),
  },
  {
    id: 'codex-http',
    label: 'Built-in Codex, HTTP',
    registryRoute: { kind: 'built-in', providerId: 'codex' },
    wireFamily: 'codex-responses',
    transport: 'http-sse',
    chainingMode: 'server-managed',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: 'previous_response_id',
    requiredScenarios: requiredScenarios('codex-http'),
  },
  {
    id: 'codex-websocket',
    label: 'Built-in Codex, WebSocket',
    registryRoute: { kind: 'built-in', providerId: 'codex' },
    wireFamily: 'codex-responses',
    transport: 'websocket',
    chainingMode: 'server-managed',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: 'previous_response_id',
    requiredScenarios: requiredScenarios('codex-websocket'),
  },
  {
    id: 'openrouter-http',
    label: 'Built-in OpenRouter',
    registryRoute: { kind: 'built-in', providerId: 'openrouter' },
    wireFamily: 'ai-sdk-chat',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'provider-dependent',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('openrouter-http'),
  },
  {
    id: 'runtime-openai-chat',
    label: 'Runtime openai',
    registryRoute: { kind: 'runtime', providerId: 'runtime-openai', runtimeType: 'openai' },
    wireFamily: 'chat-completions',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'provider-dependent',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('runtime-openai-chat'),
  },
  {
    id: 'runtime-openai-compatible-chat',
    label: 'Runtime openai-compatible',
    registryRoute: { kind: 'runtime', providerId: 'runtime-openai-compatible', runtimeType: 'openai-compatible' },
    wireFamily: 'chat-completions',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'provider-dependent',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('runtime-openai-compatible-chat'),
  },
  {
    id: 'runtime-llama-cpp-chat',
    label: 'Runtime llama.cpp',
    registryRoute: { kind: 'runtime', providerId: 'runtime-llama-cpp', runtimeType: 'llama.cpp' },
    wireFamily: 'chat-completions',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'provider-dependent',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('runtime-llama-cpp-chat'),
  },
  {
    id: 'runtime-anthropic-messages',
    label: 'Runtime Anthropic',
    registryRoute: { kind: 'runtime', providerId: 'runtime-anthropic', runtimeType: 'anthropic' },
    wireFamily: 'anthropic-messages',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('runtime-anthropic-messages'),
  },
  {
    id: 'runtime-google-generate-content',
    label: 'Runtime Google',
    registryRoute: { kind: 'runtime', providerId: 'runtime-google', runtimeType: 'google' },
    wireFamily: 'google-generate-content',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: null,
    requiredScenarios: requiredScenarios('runtime-google-generate-content'),
  },
  {
    id: 'opencode-chat-completions',
    label: 'OpenCode Chat route',
    registryRoute: { kind: 'runtime', providerId: 'opencode-chat', runtimeType: 'opencode' },
    wireFamily: 'chat-completions',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'provider-dependent',
    nativeContinuationField: 'x-opencode-session',
    requiredScenarios: requiredScenarios('opencode-chat-completions'),
  },
  {
    id: 'opencode-anthropic-messages',
    label: 'OpenCode Anthropic route',
    registryRoute: { kind: 'runtime', providerId: 'opencode-anthropic', runtimeType: 'opencode' },
    wireFamily: 'anthropic-messages',
    transport: 'http-sse',
    chainingMode: 'stateless',
    toolSupport: { supportsTools: true, supportsApproval: true },
    reasoningSupport: 'native',
    nativeContinuationField: 'x-opencode-session',
    requiredScenarios: requiredScenarios('opencode-anthropic-messages'),
  },
] as const;

export function validateProviderCapabilityMatrix(matrix: readonly ProviderCapability[]): void {
  const ids = new Set<string>();
  for (const row of matrix) {
    if (ids.has(row.id)) throw new Error(`Capability matrix contains duplicate row '${row.id}'.`);
    ids.add(row.id);
    if (!row.registryRoute.providerId) throw new Error(`Capability row '${row.id}' has no registry route.`);
    if (row.requiredScenarios.length === 0) throw new Error(`Capability row '${row.id}' has no required scenarios.`);
    if (new Set(row.requiredScenarios).size !== row.requiredScenarios.length)
      throw new Error(`Capability row '${row.id}' contains duplicate required scenarios.`);
    if (row.exclusion && (!row.exclusion.reason.trim() || !row.exclusion.evidence.trim()))
      throw new Error(`Capability row '${row.id}' has an incomplete exclusion.`);
  }
}

export function accountProviderCapabilityMatrix(
  matrix: readonly ProviderCapability[],
  executions: readonly CapabilityExecution[],
): CapabilityAccounting {
  validateProviderCapabilityMatrix(matrix);
  const rows = new Map(matrix.map((row) => [row.id, row]));
  const invalidExecutions = executions
    .filter((execution) => {
      const row = rows.get(execution.rowId);
      return !row || !row.requiredScenarios.includes(execution.scenarioId);
    })
    .map((execution) => `${execution.rowId}:${execution.scenarioId}`);
  const accounted: string[] = [];
  const unaccounted: string[] = [];
  for (const row of matrix) {
    const executed = executions.some(
      (execution) => execution.rowId === row.id && row.requiredScenarios.includes(execution.scenarioId),
    );
    if (executed || row.exclusion) accounted.push(row.id);
    else unaccounted.push(row.id);
  }
  return { accounted, unaccounted, invalidExecutions };
}

/** Fail the gate rather than allowing a missing row to disappear from reports. */
export function assertProviderCapabilityAccounting(
  matrix: readonly ProviderCapability[],
  executions: readonly CapabilityExecution[],
): void {
  const accounting = accountProviderCapabilityMatrix(matrix, executions);
  const failures = [
    ...(accounting.unaccounted.length
      ? [`unexecuted and unexcluded capability rows: ${accounting.unaccounted.join(', ')}`]
      : []),
    ...(accounting.invalidExecutions.length
      ? [`execution ledger contains unknown scenarios: ${accounting.invalidExecutions.join(', ')}`]
      : []),
  ];
  if (failures.length) throw new Error(failures.join('\n'));
}
