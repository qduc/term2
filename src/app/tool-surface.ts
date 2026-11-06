import { withActiveWorkspaceRoot } from '../tools/workspace/active-workspace-root.js';
/** Direct executable assembly: source tool leaves and policy, without the legacy runtime. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { buildAgent, buildAgentTools, type AgentFactoryDeps } from './lib/agent-factory.js';
import { createEditorImpl } from '../shared/lib/editor-impl.js';
import { getCatalogModel } from '../model/providers/model-catalog/catalog.js';
import { resolveRequestOutput } from '../engine/agent-runtime/model-context-policy.js';
import { NonInteractiveApprovalPolicy } from '../session/approval/non-interactive-approval-policy.js';
import { ToolApprovalPolicyRegistry } from '../session/approval/tool-approval-policy-registry.js';
import { isAutoApprovableTool, ShellAutoApprovalResolver } from '../session/approval/shell-auto-approval-resolver.js';
import type { ConversationRecord } from '../session/conversation/conversation-record.js';
import type { ShellAutoApprovalAgentClient } from '../session/conversation-agent-client.js';
import type { ExecutionContext } from '../tools/execution-context.js';
import { LocalExecutionContext } from './tool-contract.js';
import { primeActiveProfileNoticeIfActive } from '../session/mode-notices.js';
import { installPlanModeInterceptor } from '../tools/plan-mode-interceptor.js';
import { SessionAccessState } from '../session/session/session-access-state.js';
import { SkillsService } from '../tools/skills/skills-service.js';
import { bindRunCodeRegistry } from '../tools/system/run-code/run-code.js';
import { TOOL_NAME_DESCRIBE } from '../tools/system/run-code/script-surface.js';
import type { AnyToolDefinition } from '../tools/types.js';
import { InvalidatableShellChildRegistry } from '../shared/utils/shell/shell-child-registry.js';
import type { ProviderInputItem } from '../shared/contracts/provider-input.js';
import type { ToolContextSeed } from '../engine/index.js';
import type { Workspace } from '../tools/index.js';
import type { Item, ItemId, ModelRegistry, ReasoningEffort } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import { createDirectSubagentTools } from '../delegation/index.js';
import { createDirectShellTools } from './shell-tools.js';
import { createSourceToolRegistry, executeSourceChild, sourceToolSpec, sourceToolContext } from './source-tools.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';
import { SSH_LOCAL_ONLY_TOOLS } from './remote-tools.js';
import { renderDurableGoalContext } from '../session/goal.js';
import type { DirectContextPort } from '../session/capabilities.js';

type ToolInterceptor = Parameters<Parameters<typeof installPlanModeInterceptor>[0]['addToolInterceptor']>[0];

/** Build one generation's graph and frozen MCP catalog/policy together.
 * App retains old generations for their branches and rebuilds at idle on catalog changes. */
export function createToolSurface(selection: ProfileSelection, options: ToolSurfaceOptions = {}): AgentSurface {
  const { settings, logger } = selection;
  const modelSelection = settings.get('agent.modelSelection');
  const remote = options.remote;
  const workspace = surfaceWorkspace(options.workspace, remote);
  if (remote && options.mcp) throw new Error('Direct MCP is unavailable for SSH workspaces');
  // Despite its adapter API name, capture once per GENERATION, not per request.
  // Declaration, script execution and headless policy share this frozen catalog;
  // app owns refresh/configure and the manager outlives every retained surface.
  const mcp = options.mcp?.captureRequest();
  const targetInvocation = remote
    ? <T>(toolName: string, context: unknown, operation: () => Promise<T>) => {
        const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
        if (!signal) throw new Error('Remote tool invocation has no cancellation scope');
        return remote.runTool(toolName, signal, operation);
      }
    : undefined;
  // Pin one context per surface; never retarget process.cwd or the global
  // active-workspace fallback while another Session owns tools/background work.
  const executionContext =
    remote?.executionContext ?? options.localExecutionContext ?? new LocalExecutionContext(workspace.root);
  if (!remote && (executionContext.isRemote() || executionContext.getHomeWorkspace() !== workspace.root))
    throw new Error('Local tool context does not match the authorized workspace home');
  // SkillsService is local-fs-only. Never scan a same-spelled remote path locally.
  const skillsService = remote ? undefined : new SkillsService(logger, executionContext.getCwd());
  skillsService?.discoverSkills();
  const policies = new ToolApprovalPolicyRegistry();
  const readOnly = remote?.sourcePolicy.readOnly ?? workspace.access === 'read';
  const sessionAccess = new SessionAccessState(settings, { allowEdit: remote?.sourcePolicy.allowEdit ?? !readOnly });
  const shellChildren = new InvalidatableShellChildRegistry();
  const sessionId = randomUUID();
  const advisoryAbort = new AbortController();
  const answers = new AsyncLocalStorage<string>();
  const interceptors = new Set<ToolInterceptor>();
  const removePlanInterceptor = installPlanModeInterceptor(
    {
      addToolInterceptor(interceptor) {
        interceptors.add(interceptor);
        return () => {
          interceptors.delete(interceptor);
        };
      },
    },
    { settingsService: settings },
  );
  let sourceGraph: AnyToolDefinition[] = [];
  let nativeToolSlots: {
    beforeMemory: readonly string[];
    beforeRollover: readonly string[];
    beforeGoal: readonly string[];
    sessions: boolean;
  } = { beforeMemory: [], beforeRollover: [], beforeGoal: [], sessions: false };
  let baseGraph: AnyToolDefinition[] = [];
  // Legacy reads only list/search/read; the native browser has no lifecycle of its own.
  const sessionBrowser = remote ? undefined : (options.sessionBrowserSource as AgentFactoryDeps['sessionBrowser']);
  const checkInterceptors = async (name: string, params: unknown) => {
    for (const interceptor of interceptors) {
      const rejection = await interceptor(name, params);
      if (rejection) return rejection;
    }
    return null;
  };
  const delegation = createDirectSubagentTools({
    selection,
    workspace,
    executionContext,
    skillsService,
    readOnly,
    graph: () => sourceGraph,
    toolContext: sourceToolContext,
    createExecutionContext: (root) => new LocalExecutionContext(root),
    createRegistry: (definitions, { executionContext: childContext, policies: childPolicies }) =>
      createSourceToolRegistry(definitions, {
        withWorkspace: (operation) =>
          childContext.isRemote() ? operation() : withActiveWorkspaceRoot(() => childContext.getCwd(), operation),
        policies: childPolicies,
        settings,
        trimConfig: options.trimConfig,
        sessionAccess,
        sessionId,
        withAnswer: (answer, operation) => answers.run(answer, operation),
        checkInterceptors,
      }),
    targetInvocation,
    remoteUnavailable: SSH_LOCAL_ONLY_TOOLS,
    sessionBrowser,
    advisoryClient: advisoryClient(createProviderRegistry(selection), selection, advisoryAbort.signal),
  });
  const shell = createDirectShellTools();
  const allowBackgroundShell = options.interactive === true && !remote;
  let goalPort: Pick<DirectContextPort, 'read' | 'commit'> | undefined;
  const goalDeps: Pick<AgentFactoryDeps, 'getGoal' | 'proposeGoal'> = {
    getGoal: () => goalPort?.read().goal.goal,
    proposeGoal: {
      // The approved proposal persists the goal; legacy sets its once-per-session guard on the same write.
      appendGoal: (goal) => {
        const state = goalPort?.read().goal;
        if (
          !goalPort ||
          !state ||
          !goalPort.commit(state.generation, [
            { type: 'goal_proposed', goal },
            { type: 'goal_changed', goal, source: 'proposal' },
          ])
        )
          throw new Error('The goal changed while awaiting approval; no goal was created.');
      },
      hasPriorProposal: () => goalPort?.read().goal.proposalMade ?? false,
    },
  };
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    editor: createEditorImpl({ loggingService: logger, settingsService: settings, executionContext }),
    providerId: modelSelection.provider,
    serviceTierOverrideForNextRequest: null,
    approvalPolicyRegistry: policies,
    mcpToolSource: mcp?.source,
    sessionAccess,
    readOnly,
    shellChildRegistry: shellChildren,
    skillsService,
    sessionBrowser,
    onNativeToolSlots(slots) {
      nativeToolSlots = slots;
    },
    onToolGraph(graph) {
      sourceGraph = [...graph];
      baseGraph = [...graph];
    },
    includeMemory: !remote && options.includeMemory !== false,
    promptMemoryEnabled: !remote && options.promptMemoryEnabled === true,
    projectInstructions: options.projectInstructions,
    withToolInvocation: (name, context, operation) =>
      shell.withInvocation(name, context, () => delegation.withInvocation(name, context, operation)),
    // Session owns the live goal tool and applicability context.
    ...delegation.callbacks,
    getAskUserAnswer: () => answers.getStore(),
    // Legacy's root gets the goal, which offers propose_goal where the profile allows asking the user (agent.ts).
    ...(options.interactive === true ? goalDeps : {}),
    async checkToolInterceptors(name, params, callId) {
      for (const interceptor of interceptors) {
        const rejection = await interceptor(name, params, callId);
        if (rejection !== null) return rejection;
      }
      return null;
    },
    executeScriptedTool: executeSourceChild,
    // Match the frozen old CLI: interactive local sessions only, never batch.
    allowBackgroundShell,
    backgroundShellRegistry: allowBackgroundShell ? shell.registry : undefined,
    backgroundShellOutput: allowBackgroundShell ? shell.output : undefined,
    allowAskUser: options.interactive === true,
    allowUnsandboxed:
      options.allowUnsandboxed !== false && !readOnly && (remote?.sourcePolicy.allowUnsandboxed ?? true),
    discordSend: options.discordSend,
    isDiscordInputEnabled: options.isDiscordInputEnabled,
    // A source AgentHandle would adopt the old loop. Omit the unsupported
    // workflow tool instead of advertising a runtime that cannot execute it.
    getAgentRuntime: () => null,
    configureTaskCheckIn: delegation.configureTaskCheckIn,
    setTaskCheckInPolicy: delegation.setTaskCheckInPolicy,
  };
  const { agent } = buildAgent(
    { selection: modelSelection, reasoningEffort: settings.get('agent.reasoningEffort') },
    deps,
  );
  const offered = remote ? agent.tools.filter((tool) => !SSH_LOCAL_ONLY_TOOLS.has(tool.name)) : agent.tools;
  const withWorkspace = <T>(operation: () => T): T =>
    remote ? operation() : withActiveWorkspaceRoot(() => executionContext.getCwd(), operation);
  const registry = createSourceToolRegistry(offered, {
    withWorkspace,
    policies,
    settings,
    trimConfig: options.trimConfig,
    sessionAccess,
    sessionId,
    withAnswer: (answer, operation) => answers.run(answer, operation),
    checkInterceptors: deps.checkToolInterceptors,
  });
  const modelSettings = agent.modelSettings;
  const maxOutputTokens = resolveRequestOutput(
    getCatalogModel(modelSelection.provider, agent.model),
    modelSettings?.maxTokens,
  );
  const reasoning = (modelSettings?.reasoning as { effort?: ReasoningEffort } | undefined)?.effort;
  const providerOptions = modelSettings?.providerData as AgentSurface['providerOptions'];
  const temperature = modelSettings?.temperature as number | undefined;
  let notice: string | null = null;
  primeActiveProfileNoticeIfActive(settings, (text) => {
    notice = text;
  });
  const agentClient = advisoryClient(createProviderRegistry(selection), selection, advisoryAbort.signal);
  // Legacy's in-loop advisory (approval batch coordinator): it sees the pending
  // call in history and caches per call id; `auto` mode may approve from it.
  let advisoryHistory: ProviderInputItem[] = [];
  const advisor = new ShellAutoApprovalResolver({
    record: { getHistory: () => advisoryHistory } as unknown as ConversationRecord,
    agentClient,
    logger,
    settingsService: settings,
    sessionContextService: selection.sessionContext,
    sessionAccess,
  });
  const policy = new NonInteractiveApprovalPolicy({
    settingsService: settings,
    logger,
    sessionContextService: selection.sessionContext,
    agentClient,
    // Exactly the source run_code collision set; MCP adapter owns member identity
    // and allowlist matching. No second name policy or live catalog lookup here.
    ...mcp?.approvalPolicy(new Set([...sourceGraph.map((tool) => tool.name), TOOL_NAME_DESCRIBE])),
  });
  return {
    profileName: displayName(String(settings.get('app.activeProfileId'))),
    instructions: withoutGoalContext(agent.resolveInstructionsForRequest?.() ?? String(agent.instructions)),
    tools: offered.map(sourceToolSpec),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    notice,
    runtime: {
      nativeToolSlots,
      tools: registry,
      resolveNestedAuthority: delegation.resolveNestedAuthority,
      bindTaskCheckIn: delegation.bindTaskCheckIn,
      bindGoal(port) {
        goalPort = port;
      },
      resetAdaptedTools() {
        sourceGraph.splice(0, sourceGraph.length, ...baseGraph);
        bindRunCodeRegistry(sourceGraph);
      },
      adaptTool(definition) {
        if (remote) throw new Error('Native local source-leaf adaptation is unavailable for SSH workspaces');
        if (baseGraph.some((tool) => tool.name === definition.name))
          throw new Error(`Native source leaf collides with the fixed graph: ${definition.name}`);
        const [wrapped] = buildAgentTools({
          toolDefinitions: [definition],
          resolvedModel: agent.model,
          shouldUseNativePatchTool: false,
          deps: { ...deps, onToolGraph: undefined },
        });
        if (!wrapped) throw new Error('Native source leaf was not adapted');
        const old = sourceGraph.findIndex((tool) => tool.name === wrapped.name);
        if (old < 0) {
          const preceding = new Set(nativeToolSlots.beforeMemory);
          let at = sourceGraph.reduce((at, tool, index) => (preceding.has(tool.name) ? index + 1 : at), 0);
          const fixed = new Set(baseGraph.map((tool) => tool.name));
          while (at < sourceGraph.length && !fixed.has(sourceGraph[at]!.name)) at++;
          sourceGraph.splice(at, 0, wrapped);
        } else sourceGraph[old] = wrapped;
        bindRunCodeRegistry(sourceGraph);
        return registry.adaptTool(wrapped);
      },
      toolContext: toolContext(selection, workspace, executionContext),
      maxParallelToolCalls: settings.get('agent.maxParallelToolCalls') ?? 3,
      async dispose() {
        advisoryAbort.abort();
        registry.dispose();
        delegation.dispose();
        shell.dispose();
        shellChildren.invalidate();
        sessionAccess.dispose();
        removePlanInterceptor();
        policies.clear();
        answers.disable();
        await remote?.close();
      },
    },
    async decideInteraction(request, history) {
      if (request.presentation?.requiresExplicitUser === true)
        return { kind: 'deny', reason: 'This decision requires an explicit user answer' };
      if (request.kind === 'question') {
        // This policy has no user to answer. Resolve the exact question with
        // the stop marker, not an approval denial (which Session must reject).
        // Session commits before resolution; the engine records the unanswered
        // result and stops continuation, rather than cancelling that settlement.
        return { kind: 'answer', answer: '', stopAfterApprovalResolution: true };
      }
      // Headless auto-approval never silently grants Docker host control.
      if (isDockerRequest(request.toolName, request.input, sessionAccess)) {
        return { kind: 'deny', reason: 'Docker host control requires an explicit interactive approval' };
      }
      const callId = request.sourceCallId ?? request.requestId;
      if (isAutoApprovableTool(request.toolName) && settings.get('shell.autoApproveMode') !== 'always') {
        advisoryHistory = approvalHistory(history);
        const advisory = await withWorkspace(() =>
          advisor.resolveAdvisoryForInterruption({
            interruption: { name: request.toolName, arguments: request.input, callId },
            siblings: [{ name: request.toolName, arguments: request.input, callId }],
          }),
        );
        if (advisor.shouldAutoApprove(advisory)) return { kind: 'allow' };
      }
      // Legacy's headless continuation then decides from the session history,
      // which does not yet hold the paused response's unresolved calls.
      const decision = await withWorkspace(() =>
        policy.decide({
          autoApprove: options.autoApprove === true,
          approval: {
            agentName: agent.name,
            toolName: request.toolName,
            argumentsText: approvalArguments(request.toolName, request.input),
            rawInterruption: null,
            callId,
          },
          getHistory: () => approvalHistory(settledHistory(history)),
        }),
      );
      return decision.answer === 'y' ? { kind: 'allow' } : { kind: 'deny', reason: decision.rejectionReason };
    },
  };
}

/** Snapshot authority before building tools; an SSH adapter must match a current grant exactly. */
function surfaceWorkspace(workspace: Workspace | undefined, remote: ToolSurfaceOptions['remote']): Workspace {
  if (remote && !workspace) throw new Error('Direct SSH tool surface requires an explicit authorized workspace');
  const selected: Workspace = workspace ?? { root: process.cwd(), target: 'local', access: 'read_write' };
  if (selected.access !== 'read' && selected.access !== 'read_write')
    throw new Error('Invalid direct workspace access');
  if (remote) {
    const granted = remote.workspace;
    if (selected.target !== granted.target || selected.root !== granted.root || selected.access !== granted.access)
      throw new Error('Direct SSH adapter does not match the authorized workspace');
    if (!remote.executionContext.isRemote() || !remote.executionContext.getSSHService()?.isConnected())
      throw new Error('Direct SSH tool surface requires its connected execution context');
    return granted;
  }
  if (selected.target !== 'local') throw new Error('Direct remote tools require a connected adapter');
  return Object.freeze({ ...selected });
}

function displayName(profileId: string): string {
  return profileId === 'builtin:standard' ? 'full' : profileId.replace(/^builtin:/, '');
}

function toolContext(
  { settings }: ProfileSelection,
  workspace: Workspace,
  executionContext: ExecutionContext,
): ToolContextSeed {
  return {
    get workspace() {
      return Object.freeze({ ...workspace, root: executionContext.getCwd() });
    },
    settings: {
      get: (key) => settings.getDynamic(key) as ReturnType<ToolContextSeed['settings']['get']>,
      watch(listener) {
        return (
          settings.onChange?.((key) => {
            if (key)
              listener({
                key: key as Parameters<ToolContextSeed['settings']['get']>[0],
                previous: undefined,
                next: settings.getDynamic(key) as ReturnType<ToolContextSeed['settings']['get']>,
              });
          }) ?? (() => {})
        );
      },
    },
  };
}

function approvalArguments(name: string, input: unknown): string {
  if (
    (name === 'shell' || name === 'bash') &&
    input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
  ) {
    return input.command;
  }
  return JSON.stringify(input) ?? '';
}

function isDockerRequest(name: string, input: unknown, access: SessionAccessState): boolean {
  return (
    name === 'shell' &&
    !!input &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string' &&
    access.requiresDockerApproval(input.command)
  );
}

/** History without tool calls that have no result yet. */
function settledHistory(history: readonly Item[]): readonly Item[] {
  const settled = new Set(history.flatMap((item) => (item.type === 'tool_result' ? [item.callId] : [])));
  return history.filter((item) => item.type !== 'tool_call' || settled.has(item.callId));
}

function approvalHistory(history: readonly Item[]): ProviderInputItem[] {
  return history.flatMap((item): ProviderInputItem[] => {
    switch (item.type) {
      case 'user_message':
      case 'assistant_message':
        return [
          {
            type: 'message',
            role: item.type === 'user_message' ? 'user' : 'assistant',
            content: item.content
              .filter((part) => part.type === 'text')
              .map((part) => ({ type: 'input_text', text: part.text })),
          },
        ];
      case 'tool_call':
        return [
          {
            type: 'function_call',
            name: item.toolName,
            call_id: item.callId,
            arguments: item.rawArguments ?? JSON.stringify(item.input),
          },
        ];
      case 'tool_result':
        return [{ type: 'function_call_output', call_id: item.callId, output: item.output }];
      default:
        return [];
    }
  });
}

/** One tool-free model request for the existing approval evaluator; never starts an agent loop. */
function advisoryClient(
  models: ModelRegistry,
  { settings }: ProfileSelection,
  surfaceSignal: AbortSignal,
): ShellAutoApprovalAgentClient {
  return {
    async chat(message, options = {}) {
      const configured = settings.get('agent.modelSelection');
      const model = { provider: options.provider ?? configured.provider, model: options.model ?? configured.model };
      const effort = options.reasoningEffort;
      const signal = options.signal ? AbortSignal.any([options.signal, surfaceSignal]) : surfaceSignal;
      signal.throwIfAborted();
      let deltas = '';
      const completed: string[] = [];
      let ended = false;
      for await (const event of models.resolve(model).stream(
        {
          model,
          instructions: options.instructions ?? '',
          tools: [],
          input: [
            {
              type: 'user_message',
              id: `approval:${randomUUID()}` as ItemId,
              content: [{ type: 'text', text: message }],
            },
          ],
          ...(effort && effort !== 'default' ? { reasoning: effort } : {}),
          ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        },
        signal,
      )) {
        if (event.type === 'text_delta') deltas += event.delta;
        if (event.type === 'item' && event.item.type === 'assistant_message') {
          completed.push(
            event.item.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          );
        }
        if (event.type === 'done') {
          if (event.stopReason !== 'end_turn') throw new Error(`Approval model stopped with ${event.stopReason}`);
          ended = true;
        }
      }
      if (!ended) throw new Error('Approval model ended without a completion');
      return completed.length > 0 ? completed.join('') : deltas;
    },
  };
}

/** The Session renders the goal per request (planDirectInstructions); drop the unbound source copy. */
function withoutGoalContext(instructions: string): string {
  const unbound = renderDurableGoalContext(undefined);
  return instructions.endsWith(unbound) ? instructions.slice(0, -unbound.length) : instructions;
}
