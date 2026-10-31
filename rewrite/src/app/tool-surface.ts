/** Direct executable assembly: source tool leaves and policy, without the legacy runtime. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { buildAgent, type AgentFactoryDeps } from '../../../source/lib/agent-factory.js';
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
import { InvalidatableShellChildRegistry } from '../../../source/utils/shell/shell-child-registry.js';
import type { ProviderInputItem } from '../../../source/contracts/provider-input.js';
import type { ToolContextSeed } from '../engine/index.js';
import type { Item, ItemId, ModelRegistry, ReasoningEffort } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import { createSourceToolRegistry, executeSourceChild, sourceToolSpec } from '../tools/source-tools.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

const unavailable = async (): Promise<never> => {
  throw new Error('This capability is not wired into the direct runtime yet');
};
type ToolInterceptor = Parameters<Parameters<typeof installPlanModeInterceptor>[0]['addToolInterceptor']>[0];

/** Build the source graph once, retain its script binding, and expose only its final direct offering. */
export function createToolSurface(selection: ProfileSelection, options: ToolSurfaceOptions = {}): AgentSurface {
  const { settings, logger } = selection;
  const modelSelection = settings.get('agent.modelSelection');
  const executionContext = new ExecutionContext();
  const skillsService = new SkillsService(logger, executionContext.getCwd());
  skillsService.discoverSkills();
  const policies = new ToolApprovalPolicyRegistry();
  const sessionAccess = new SessionAccessState(settings);
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
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    editor: createEditorImpl({ loggingService: logger, settingsService: settings, executionContext }),
    providerId: modelSelection.provider,
    serviceTierOverrideForNextRequest: null,
    approvalPolicyRegistry: policies,
    sessionAccess,
    shellChildRegistry: shellChildren,
    skillsService,
    getGoal: () => undefined,
    createMentor: unavailable,
    runSubagent: unavailable,
    runSubagentAsync: unavailable,
    getSubagentResult: unavailable,
    getSubagentStatus: unavailable,
    sendSubagentMessage: unavailable,
    cancelSubagentRun: unavailable,
    runResolvedSubagent: unavailable,
    runResolvedSubagentAsync: unavailable,
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
    allowUnsandboxed: true,
    // Keep the tool declaration, but do not create an old agent/runtime for it.
    getAgentRuntime: () => ({
      agent: () => {
        throw new Error('Nested model runs are not wired into the direct runtime yet');
      },
    }),
    configureTaskCheckIn: unavailable,
    setTaskCheckInPolicy: () => {},
  };
  const { agent } = buildAgent(
    { selection: modelSelection, reasoningEffort: settings.get('agent.reasoningEffort') },
    deps,
  );
  const registry = createSourceToolRegistry(agent.tools, {
    policies,
    settings,
    sessionAccess,
    sessionId,
    withAnswer: (answer, operation) => answers.run(answer, operation),
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
    tools: agent.tools.map(sourceToolSpec),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    notice,
    runtime: {
      tools: registry,
      toolContext: toolContext(selection, executionContext),
      maxParallelToolCalls: settings.get('agent.maxParallelToolCalls') ?? 3,
      dispose() {
        advisoryAbort.abort();
        registry.dispose();
        shellChildren.invalidate();
        sessionAccess.dispose();
        removePlanInterceptor();
        policies.clear();
        answers.disable();
      },
    },
    async decideInteraction(request, history) {
      if (request.kind === 'question') return { kind: 'deny', reason: 'Questions require an interactive user' };
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

function displayName(profileId: string): string {
  return profileId === 'builtin:standard' ? 'full' : profileId.replace(/^builtin:/, '');
}

function toolContext({ settings }: ProfileSelection, executionContext: ExecutionContext): ToolContextSeed {
  return {
    workspace: { root: executionContext.getCwd(), target: 'local', access: 'read_write' },
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
