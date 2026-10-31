/** Direct executable assembly: source tool leaves and policy, without the legacy runtime. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { buildAgent, buildAgentTools, type AgentFactoryDeps } from '../../../source/lib/agent-factory.js';
import { createEditorImpl } from '../../../source/lib/editor-impl.js';
import { getCatalogModel } from '../../../source/providers/model-catalog/catalog.js';
import { resolveRequestOutput } from '../../../source/services/agent-runtime/model-context-policy.js';
import { NonInteractiveApprovalPolicy } from '../../../source/services/approval/non-interactive-approval-policy.js';
import { ToolApprovalPolicyRegistry } from '../../../source/services/approval/tool-approval-policy-registry.js';
import type { ShellAutoApprovalAgentClient } from '../../../source/services/conversation-agent-client.js';
import { ExecutionContext } from '../../../source/services/execution-context.js';
import { primeActiveProfileNoticeIfActive } from '../../../source/services/mode-notices.js';
import { installPlanModeInterceptor } from '../../../source/services/plan-mode-interceptor.js';
import { SessionAccessState } from '../../../source/services/session/session-access-state.js';
import { SkillsService } from '../../../source/services/skills/skills-service.js';
import { bindRunCodeRegistry } from '../../../source/tools/system/run-code/run-code.js';
import type { AnyToolDefinition } from '../../../source/tools/types.js';
import { InvalidatableShellChildRegistry } from '../../../source/utils/shell/shell-child-registry.js';
import type { ProviderInputItem } from '../../../source/contracts/provider-input.js';
import type { ToolContextSeed } from '../engine/index.js';
import type { Workspace } from '../tools/index.js';
import type { Item, ItemId, ModelRegistry, ReasoningEffort } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import { createDirectSubagentTools } from './direct-subagent-tools.js';
import { createSourceToolRegistry, executeSourceChild, sourceToolSpec } from '../tools/source-tools.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

type ToolInterceptor = Parameters<Parameters<typeof installPlanModeInterceptor>[0]['addToolInterceptor']>[0];

/** Build the source graph once, retain its script binding, and expose only its final direct offering. */
export function createToolSurface(selection: ProfileSelection, options: ToolSurfaceOptions = {}): AgentSurface {
  const { settings, logger } = selection;
  const modelSelection = settings.get('agent.modelSelection');
  const remote = options.remote;
  const workspace = surfaceWorkspace(options.workspace, remote);
  const targetInvocation = remote
    ? <T>(toolName: string, context: unknown, operation: () => Promise<T>) => {
        const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
        if (!signal) throw new Error('Remote tool invocation has no cancellation scope');
        return remote.runTool(toolName, signal, operation);
      }
    : undefined;
  // Pin one context per surface; never retarget process.cwd or the global
  // active-workspace fallback while another Session owns tools/background work.
  const executionContext = remote?.executionContext ?? ExecutionContext.pin(workspace.root);
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
  let baseGraph: AnyToolDefinition[] = [];
  const delegation = createDirectSubagentTools({
    selection,
    workspace,
    executionContext,
    skillsService,
    sessionAccess,
    sessionId,
    readOnly,
    graph: () => sourceGraph,
    checkInterceptors: async (name, params) => {
      for (const interceptor of interceptors) {
        const rejection = await interceptor(name, params);
        if (rejection) return rejection;
      }
      return null;
    },
    withAnswer: (answer, operation) => answers.run(answer, operation),
    targetInvocation,
    remoteUnavailable: REMOTE_UNAVAILABLE,
  });
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    editor: createEditorImpl({ loggingService: logger, settingsService: settings, executionContext }),
    providerId: modelSelection.provider,
    serviceTierOverrideForNextRequest: null,
    approvalPolicyRegistry: policies,
    sessionAccess,
    readOnly,
    shellChildRegistry: shellChildren,
    skillsService,
    onToolGraph(graph) {
      sourceGraph = graph;
      baseGraph = [...graph];
    },
    includeMemory: !remote && options.includeMemory !== false,
    projectInstructions: options.projectInstructions,
    withToolInvocation: delegation.withInvocation,
    getGoal: () => undefined,
    ...delegation.callbacks,
    getAskUserAnswer: () => answers.getStore(),
    async checkToolInterceptors(name, params, callId) {
      for (const interceptor of interceptors) {
        const rejection = await interceptor(name, params, callId);
        if (rejection !== null) return rejection;
      }
      return null;
    },
    executeScriptedTool: executeSourceChild,
    allowBackgroundShell: false,
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
  const offered = remote ? agent.tools.filter((tool) => !REMOTE_UNAVAILABLE.has(tool.name)) : agent.tools;
  const registry = createSourceToolRegistry(offered, {
    policies,
    settings,
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
  const policy = new NonInteractiveApprovalPolicy({
    settingsService: settings,
    logger,
    sessionContextService: selection.sessionContext,
    agentClient: advisoryClient(createProviderRegistry(selection), selection, advisoryAbort.signal),
  });
  return {
    profileName: displayName(String(settings.get('app.activeProfileId'))),
    instructions: agent.resolveInstructionsForRequest?.() ?? String(agent.instructions),
    tools: offered.map(sourceToolSpec),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    notice,
    runtime: {
      tools: registry,
      resolveNestedAuthority: delegation.resolveNestedAuthority,
      bindTaskCheckIn: delegation.bindTaskCheckIn,
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
        if (old < 0) sourceGraph.push(wrapped);
        else sourceGraph[old] = wrapped;
        bindRunCodeRegistry(sourceGraph);
        return registry.adaptTool(wrapped);
      },
      toolContext: toolContext(selection, workspace),
      maxParallelToolCalls: settings.get('agent.maxParallelToolCalls') ?? 3,
      async dispose() {
        advisoryAbort.abort();
        registry.dispose();
        delegation.dispose();
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
      const decision = await policy.decide({
        autoApprove: options.autoApprove === true,
        approval: {
          agentName: agent.name,
          toolName: request.toolName,
          argumentsText: approvalArguments(request.toolName, request.input),
          rawInterruption: null,
          callId: request.sourceCallId ?? request.requestId,
        },
        getHistory: () => approvalHistory(history),
      });
      return decision.answer === 'y' ? { kind: 'allow' } : { kind: 'deny', reason: decision.rejectionReason };
    },
  };
}

const REMOTE_UNAVAILABLE = new Set([
  'read_code_outline',
  'code_context_search',
  'enter_worktree',
  'exit_worktree',
  'activate_skill',
]);

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

function toolContext({ settings }: ProfileSelection, workspace: Workspace): ToolContextSeed {
  return {
    workspace,
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
