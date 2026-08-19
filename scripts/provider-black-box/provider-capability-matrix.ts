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
  /** Omit to document an exclusion for the whole row; otherwise scope it to these required scenarios. */
  scenarioIds?: readonly string[];
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
  /** Additional semantic-wire evidence owned by a scenario in the shared suite. */
  auditScenarios?: readonly string[];
  exclusion?: CapabilityExclusion;
};

export type CapabilityExecution = {
  rowId: string;
  scenarioId: string;
};

export type CapabilityAccounting = {
  accounted: readonly string[];
  unaccounted: readonly string[];
  missingScenarios: readonly string[];
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

function requiredScenarios(rowId: string, transport: CapabilityTransport): readonly string[] {
  const suffixes = [
    ...REQUIRED_SCENARIO_SUFFIXES.filter((suffix) => transport === 'websocket' || suffix !== 'abnormal-close'),
    ...(transport === 'websocket' ? ['retained-connection'] : []),
  ];
  return suffixes.map((suffix) => `${rowId}.${suffix}`);
}

function sharedTerminalExclusion(
  rowId: string,
  representativeRowId: string,
  protocolLabel: string,
): CapabilityExclusion {
  return {
    reason: `The ${protocolLabel} native-error and incomplete-stream lifecycle is covered by the representative ${representativeRowId} route; ${rowId} routing and two-turn/tool lifecycle remain distinct.`,
    evidence: `provider-session-resilience.blackbox.ts executes ${representativeRowId}.native-error and ${representativeRowId}.incomplete-stream; provider-session-stateless.blackbox.ts executes ${rowId}.two-user-turn, ${rowId}.approval-approve, and ${rowId}.approval-reject.`,
    scenarioIds: [`${rowId}.native-error`, `${rowId}.incomplete-stream`],
  };
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
    requiredScenarios: requiredScenarios('openai-http', 'http-sse'),
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
    requiredScenarios: requiredScenarios('openai-websocket', 'websocket'),
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
    requiredScenarios: requiredScenarios('codex-http', 'http-sse'),
    auditScenarios: ['codex-http.two-user-turn: prompt_cache_key/include projection'],
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
    requiredScenarios: [...requiredScenarios('codex-websocket', 'websocket'), 'codex-websocket.orphan-chain-recovery'],
    auditScenarios: ['codex-websocket.two-user-turn: prompt_cache_key/include projection'],
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
    requiredScenarios: requiredScenarios('openrouter-http', 'http-sse'),
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
    requiredScenarios: requiredScenarios('runtime-openai-chat', 'http-sse'),
    exclusion: sharedTerminalExclusion(
      'runtime-openai-chat',
      'runtime-openai-compatible-chat',
      'Chat Completions HTTP/SSE',
    ),
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
    requiredScenarios: requiredScenarios('runtime-openai-compatible-chat', 'http-sse'),
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
    requiredScenarios: requiredScenarios('runtime-llama-cpp-chat', 'http-sse'),
    exclusion: sharedTerminalExclusion(
      'runtime-llama-cpp-chat',
      'runtime-openai-compatible-chat',
      'Chat Completions HTTP/SSE',
    ),
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
    requiredScenarios: requiredScenarios('runtime-anthropic-messages', 'http-sse'),
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
    requiredScenarios: requiredScenarios('runtime-google-generate-content', 'http-sse'),
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
    requiredScenarios: requiredScenarios('opencode-chat-completions', 'http-sse'),
    exclusion: sharedTerminalExclusion(
      'opencode-chat-completions',
      'runtime-openai-compatible-chat',
      'Chat Completions HTTP/SSE',
    ),
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
    requiredScenarios: requiredScenarios('opencode-anthropic-messages', 'http-sse'),
    exclusion: sharedTerminalExclusion(
      'opencode-anthropic-messages',
      'runtime-anthropic-messages',
      'Anthropic Messages HTTP/SSE',
    ),
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
    if (row.exclusion) {
      if (!row.exclusion.reason.trim() || !row.exclusion.evidence.trim())
        throw new Error(`Capability row '${row.id}' has an incomplete exclusion.`);
      if (row.exclusion.scenarioIds) {
        if (row.exclusion.scenarioIds.length === 0)
          throw new Error(`Capability row '${row.id}' has an empty exclusion scenario set.`);
        if (new Set(row.exclusion.scenarioIds).size !== row.exclusion.scenarioIds.length)
          throw new Error(`Capability row '${row.id}' contains duplicate exclusion scenarios.`);
        for (const scenarioId of row.exclusion.scenarioIds) {
          if (!row.requiredScenarios.includes(scenarioId))
            throw new Error(`Capability row '${row.id}' excludes unknown scenario '${scenarioId}'.`);
        }
      }
    }
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
  const missingScenarios: string[] = [];
  for (const row of matrix) {
    const excluded = new Set(row.exclusion?.scenarioIds ?? (row.exclusion ? row.requiredScenarios : []));
    const covered = row.requiredScenarios.filter(
      (scenarioId) =>
        excluded.has(scenarioId) ||
        executions.some((execution) => execution.rowId === row.id && execution.scenarioId === scenarioId),
    );
    const missing = row.requiredScenarios.filter((scenarioId) => !covered.includes(scenarioId));
    missingScenarios.push(...missing);
    if (covered.length > 0) accounted.push(row.id);
    else unaccounted.push(row.id);
  }
  return { accounted, unaccounted, missingScenarios, invalidExecutions };
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
    ...(accounting.missingScenarios.length
      ? [`required lifecycle scenarios are missing: ${accounting.missingScenarios.join(', ')}`]
      : []),
    ...(accounting.invalidExecutions.length
      ? [`execution ledger contains unknown scenarios: ${accounting.invalidExecutions.join(', ')}`]
      : []),
  ];
  if (failures.length) throw new Error(failures.join('\n'));
}
