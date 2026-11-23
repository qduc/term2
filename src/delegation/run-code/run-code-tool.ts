import type { ILoggingService } from '../../shared/service-interfaces.js';
import type { ExecutionContext } from '../../tools/execution-context.js';
import type { ToolRegistry } from '../../tools/types.js';
import type { McpToolSource } from '../../tools/mcp/mcp-tool-source.js';
import type { ToolApprovalPolicyRegistry } from '../../session/approval/tool-approval-policy-registry.js';
import type { NestedApprovalOwner } from '../../session/approval/nested-approval-owner.js';
import type { SessionAccessState } from '../../session/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../session/session/nested-tool-compatibility-state.js';
import type { AgentSpecAuthoritySnapshot } from '../../session/agent-runtime/permission-boundary.js';
import { createRunCodeToolDefinition as createDefinition } from '../../tools/system/run-code/run-code.js';
import { RUN_CODE_LIMITS } from '../../tools/system/run-code/script-surface.js';
import { createRunCodeRuntime } from './run-code-runtime.js';
import {
  getRunCodeAgentCapabilityMembers,
  isRunCodeAgentBridgeActive,
  type RunCodeAgentSpecBridge,
} from './run-code-agent-capability.js';

/** Concrete host capabilities, retained by delegation rather than the tool leaf. */
export interface CreateRunCodeToolOptions {
  loggingService: ILoggingService;
  getToolRegistry?: () => ToolRegistry;
  approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  getCwd?: () => string;
  executionContext?: ExecutionContext;
  nestedApprovalOwner?: NestedApprovalOwner;
  sessionAccess?: SessionAccessState;
  nestedCompatibility?: NestedToolCompatibilityState;
  catalogOtherTools?: 'signatures' | 'names';
  mcpToolSource?: McpToolSource;
  agentSpecAuthority?: AgentSpecAuthoritySnapshot;
  agentSpecBridge?: RunCodeAgentSpecBridge;
}

const REGISTRY_BINDER = Symbol.for('term2.run_code.bindRegistry');
const NESTED_OWNER_BINDER = Symbol.for('term2.run_code.bindNestedApprovalOwner');
type HostBindable = {
  [REGISTRY_BINDER]?: (registry: ToolRegistry) => void;
  [NESTED_OWNER_BINDER]?: (owner: NestedApprovalOwner, graph: object) => void;
};

/** Bind the live approval owner to the complete wrapped graph, not the direct surface. */
export function bindRunCodeNestedApprovalOwner(tools: ToolRegistry, owner: NestedApprovalOwner): void {
  for (const tool of tools) (tool as HostBindable)[NESTED_OWNER_BINDER]?.(owner, tools);
}

/** Wire a thin schema/presentation definition to the one nested execution owner. */
export function createRunCodeToolDefinition(options: CreateRunCodeToolOptions) {
  let nestedApprovalOwner = options.nestedApprovalOwner;
  let boundRegistry: ToolRegistry | undefined;
  const agentReference = (): string =>
    options.agentSpecBridge && options.agentSpecAuthority && isRunCodeAgentBridgeActive(options.agentSpecBridge)
      ? renderAgentCapabilitySection(options.agentSpecBridge)
      : '';
  const definition = createDefinition({
    getToolRegistry: options.getToolRegistry,
    catalogOtherTools: options.catalogOtherTools,
    mcpToolSource: options.mcpToolSource,
    registerMcpPolicy: (tool) =>
      options.approvalPolicyRegistry.register({
        toolName: tool.name,
        parameters: tool.parameters,
        needsApproval: tool.needsApproval,
      }),
    createRuntime: (graph) =>
      createRunCodeRuntime({
        ...graph,
        loggingService: options.loggingService,
        approvalPolicyRegistry: options.approvalPolicyRegistry,
        getCwd: options.getCwd ?? (() => options.executionContext?.getCwd() || process.cwd()),
        executionContext: options.executionContext,
        nestedApprovalOwner,
        sessionAccess: options.sessionAccess,
        nestedCompatibility: options.nestedCompatibility,
        ...(options.agentSpecAuthority ? { agentSpecAuthority: options.agentSpecAuthority } : {}),
        ...(options.agentSpecBridge ? { agentBridge: options.agentSpecBridge } : {}),
        agentCapabilityReference: agentReference,
      }),
    // The full agent API is fetched on demand; every request carries only this pointer.
    agentCapabilitySection: () =>
      agentReference()
        ? '## Agent capability\nAn `agent` global (not in `tools.*`) launches child agents from the script ' +
          "(agent.run, agent.start, agent.status, agent.result, agent.cancel). Call `tools.describe('agent')` for its API before first use."
        : '',
  });
  const bindable = definition as HostBindable;
  const bindRegistry = bindable[REGISTRY_BINDER];
  bindable[REGISTRY_BINDER] = (registry) => {
    boundRegistry = registry;
    bindRegistry?.(registry);
  };
  bindable[NESTED_OWNER_BINDER] = (owner, graph) => {
    nestedApprovalOwner = owner;
    owner.bindGraph(boundRegistry ?? graph);
  };
  return definition;
}

/** Describe only capability members actually bound by the host. */
function renderAgentCapabilitySection(bridge: RunCodeAgentSpecBridge): string {
  const members = getRunCodeAgentCapabilityMembers(bridge);
  const lines: string[] = ['## Agent capability', 'When present, `agent` (not in `tools.*`) launches agents:'];
  if (members.includes('run')) {
    lines.push(
      '- `agent.run({ spec, worktree? })` awaits one and resolves to `{ status, finalText, filesChanged, toolsUsed, ... }`. ' +
        "Parallelize only independent runs with identical requirements; catch per-call rejections. Child approval waits don't consume the timeout.",
    );
  }
  if (members.includes('start')) {
    lines.push(
      "- `agent.start({ spec, name? })` starts a background run that outlives the script (`{ runId, status: 'running' }`, completion notified); " +
        '`agent.status({ runId? })`, `agent.result({ runId })`, `agent.cancel({ target })` peek, await, cancel.',
    );
  }
  lines.push(
    "- `spec`: `{ goal, tools?, permissions?, constraints?, doneWhen?, model?, budget? }`, capped at this session's authority (excess rejects).",
    `- Per script: at most ${RUN_CODE_LIMITS.maxAgentStarts} launches, ${RUN_CODE_LIMITS.maxAgentConcurrency} parallel, ${RUN_CODE_LIMITS.maxAgentCalls} agent.* calls.`,
  );
  return lines.join('\n');
}
