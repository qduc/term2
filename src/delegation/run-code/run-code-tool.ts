import type { ILoggingService } from '../../shared/service-interfaces.js';
import type { ExecutionContext } from '../../tools/execution-context.js';
import type { ToolRegistry } from '../../tools/types.js';
import type { McpToolSource } from '../../tools/mcp/mcp-tool-source.js';
import type { ToolApprovalPolicyRegistry } from '../../session/approval/tool-approval-policy-registry.js';
import type { NestedApprovalOwner } from '../../session/approval/nested-approval-owner.js';
import type { SessionAccessState } from '../../session/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../session/session/nested-tool-compatibility-state.js';
import type { AgentSpecAuthoritySnapshot } from '../../engine/agent-runtime/permission-boundary.js';
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
      }),
    agentCapabilitySection: () =>
      options.agentSpecBridge && options.agentSpecAuthority && isRunCodeAgentBridgeActive(options.agentSpecBridge)
        ? renderAgentCapabilitySection(options.agentSpecBridge)
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
  const lines: string[] = [
    '## Agent capability',
    '',
    'When present, a flat `agent` global (not a `tools.*` entry) launches host-resolved agents from the script:',
  ];
  if (members.includes('run')) {
    lines.push(
      '- `agent.run({ spec, worktree? })` awaits one foreground agent and resolves to its nested result ' +
        '(status, finalText, filesChanged, toolsUsed, ...). Fan out with `Promise.all` and catch per-call ' +
        'rejections (`agent.run failed: ...`). The host aborts the child if the script times out or is cancelled. ' +
        'When a session approval owner is bound, child tool approval pauses surface to the user and resume ' +
        'the exact child execution; the work clock pauses only while all calls await approval. ' +
        'Without that owner, or for non-tool interruptions, the child rejects rather than reporting completion.',
    );
  }
  if (members.includes('start')) {
    lines.push(
      '- `agent.start({ spec, name? })` starts a conversation-scoped background run and ' +
        "resolves to `{ runId, name?, role, status: 'running' }`; it survives this script and its timeout. " +
        '`continue_run_id` is rejected by this script capability until stored-run authority can be verified.',
      '- `agent.status({ runId? })` peeks non-blocking progress; `agent.result({ runId })` awaits the settled ' +
        'result; `agent.cancel({ target })` requests cancellation. Background completion reaches the session ' +
        'notification lane even after this script returns.',
    );
  }
  lines.push(
    '- `spec` is a plain AgentSpec (`{ goal, tools?, permissions?, constraints?, doneWhen?, model?, budget? }`). ' +
      "The host attenuates it against this session's authority before launch: requests beyond parent tools, " +
      'scopes, or the worktree scope reject per call as `Agent specification rejected: ...`; the raw spec is ' +
      'never forwarded to any launch path.',
    `- Per-script limits, separate from the tools.* budget: at most ${RUN_CODE_LIMITS.maxAgentStarts} agent launches, ` +
      `${RUN_CODE_LIMITS.maxAgentConcurrency} parallel foreground runs, and ${RUN_CODE_LIMITS.maxAgentCalls} agent.* calls.`,
  );
  return lines.join('\n');
}
