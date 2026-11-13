import { buildModelSettings, getProviderCapabilities } from './agent-model-settings.js';
import type { NestedRunDriverFactory, NestedModelBinding } from '../../tools/nested-run-driver.js';
import type { DiscordSend } from '../../clients/discord/discord-outbound.js';
import { getRunCodeExecutionResult, RUN_CODE_EXECUTION_RESULT } from '../../tools/system/run-code/run-code.js';
import type { ApplicationAgent } from '../../tools/nested-run-driver.js';
import type { ReasoningEffortSetting } from '../../tools/conversation.js';
import { getAgentDefinition } from '../agent.js';
import { createEditorImpl } from '../../tools/editor-impl.js';
import { bindRunCodeRegistry, isDirectlyCallable, TOOL_NAME_RUN_CODE } from '../../tools/system/run-code/index.js';
import { normalizeToolParameters, wrapNeedsApproval, wrapToolInvoke } from '../../tools/tool-invoke.js';
import type { ILoggingService, ISettingsService } from '../../shared/service-interfaces.js';
import type { ListWorktreesSync } from '../../tools/workspace/worktree-inventory.js';
import { ExecutionContext } from '../../tools/execution-context.js';
import { trimToolOutput } from '../../shared/utils/output/trim-tool-output.js';
import { isScriptedToolCall } from '../../shared/utils/output/bound-tool-result.js';
import { SkillsService } from '../../tools/skills/skills-service.js';
import { injectRunBudgetWarning } from '../../session/inject-warning-into-tool-output.js';
import { toOpenAIStrictToolSchema } from '../../shared/lib/openai-strict-tool-schema.js';
import { modelToolJsonSchema } from '../../shared/lib/model-tool-json-schema.js';
import {
  shouldUseNativePatchTool as shouldUseNativePatchToolPolicy,
  shouldUseStrictToolSchema,
} from '../../model/tool-selection-policy.js';
import { getModelDefaultReasoningLevel, getProviderDefaultReasoningLevel } from '../../model/model-service.js';
import type { ToolApprovalPolicyRegistry } from '../../session/approval/tool-approval-policy-registry.js';
import { shouldBypassToolApproval } from '../../session/approval/shell-auto-approval-resolver.js';
import type { AgentLauncher } from '../../session/agent-runtime/types.js';
import {
  isZodToolParameterSchema,
  type AnyToolDefinition,
  type PostExecutePauseCapability,
  type ToolRegistry,
} from '../../tools/types.js';
import type { SessionAccessState } from '../../session/session/session-access-state.js';
import type { BackgroundShellRegistryPort } from '../../tools/shell/background-shell-registry.js';
import type { BackgroundShellOutputBundle } from '../../tools/shell/background-shell-watches.js';
import type { BackgroundShellExecutionResult } from '../../tools/system/shell.js';
import type { ShellChildRegistry } from '../../tools/shell/shell-child-registry.js';
import type { SessionBrowser } from '../../session/conversation/session-browser.js';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from '../../shared/contracts/session-rollover.js';
import { UPSTREAM_APPLY_PATCH_GRAMMAR, freeformApplyPatchArguments } from '../../tools/file/upstream-apply-patch.js';
import type { McpToolSource } from '../../tools/mcp/mcp-tool-source.js';
import type { DurableGoal } from '../../session/logging/conversation-log-events.js';
import { ModelSelectionSchema, type ModelSelection } from '../../config/settings/model-selection.js';
import type { AgentSpec } from '../../session/agent-runtime/types.js';
import type { NestedSubagentResult, SubagentRunHandle } from '../../tools/subagents/types.js';
import type { ResolvedSubagentLaunch } from '../../delegation/direct/subagent-callbacks.js';

export interface AgentFactoryDeps {
  driverFactory?: NestedRunDriverFactory;
  modelBinding?: NestedModelBinding;
  settings: ISettingsService;
  logger: ILoggingService;
  /** Reads the latest successfully persisted session goal at request time. */
  getGoal?: () => DurableGoal | undefined;
  /** Interactive-only goal proposal callbacks; absent in non-interactive/gateway sessions. */
  proposeGoal?: { appendGoal: (goal: DurableGoal) => void | Promise<void>; hasPriorProposal: () => boolean };
  executionContext?: ExecutionContext;
  editor: ReturnType<typeof createEditorImpl>;
  providerId: string;
  serviceTierOverrideForNextRequest: 'standard' | null;
  createMentor: (task: string) => Promise<string>;
  runSubagent: (params: {
    role?: string;
    task?: string;
    agent_spec?: AgentSpec;
    worktree?: string;
  }) => Promise<{ finalText: string }>;
  runSubagentAsync: (
    params: {
      role?: string;
      task?: string;
      agent_spec?: AgentSpec;
      name?: string;
      continue_run_id?: string;
      worktree?: string;
    },
    context?: unknown,
    details?: unknown,
  ) => Promise<any>;
  getSubagentResult: (params: { runId: string }, context?: unknown, details?: unknown) => Promise<any>;
  getSubagentStatus?: (params: { runId?: string }, context?: unknown, details?: unknown) => any;
  sendSubagentMessage: (params: { target: string; message: string; reply_to?: string }) => any;
  cancelSubagentRun: (params: { target: string }) => any;
  /** Resolved-launch seams for the run_code script agent capability; absent means scripts cannot launch agents. */
  runResolvedSubagent?: (
    params: ResolvedSubagentLaunch,
    context?: unknown,
    details?: unknown,
  ) => Promise<NestedSubagentResult>;
  runResolvedSubagentAsync?: (params: ResolvedSubagentLaunch) => Promise<SubagentRunHandle>;
  getAskUserAnswer?: (callId?: string) => string | undefined;
  checkToolInterceptors: (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;
  skillsService?: SkillsService;
  /** Retain the complete wrapped graph, including script-only leaves, for native capability binding. */
  onToolGraph?: (tools: ToolRegistry) => void;
  /** Exact source assembly positions for Session-owned tools. */
  onNativeToolSlots?: (slots: {
    beforeMemory: readonly string[];
    beforeRollover: readonly string[];
    beforeGoal: readonly string[];
    sessions: boolean;
  }) => void;
  /** Omit local memory discovery when another owner supplies context or the workspace is remote. */
  includeMemory?: boolean;
  /** Describe real native-owned memory in the prompt without offering source tools. */
  promptMemoryEnabled?: boolean;
  /** Project text already loaded from the execution target; profile gates still apply. */
  projectInstructions?: string;
  /** Bind policy callbacks and physical bodies to their actual source leaf and invocation. */
  withToolInvocation?: <T>(toolName: string, context: unknown, operation: () => Promise<T>) => Promise<T>;
  /** Optional lazy bridge to the production one-shot agent runtime. */
  getAgentRuntime?: () => AgentLauncher | null;
  /** Root-session-only policy capability for explicitly opted-in definitions. */
  postExecutePauseCapability?: PostExecutePauseCapability;
  /** Optional pre-body gate for physical calls made by a script, never root calls. */
  executeScriptedTool?: (
    input: { toolName: string; arguments: unknown; context: unknown; details: unknown },
    execute: () => Promise<unknown>,
  ) => Promise<unknown>;
  /** Policy authority owned by this tool graph. */
  approvalPolicyRegistry: ToolApprovalPolicyRegistry;
  /** Handle-owned state for root read and Docker capabilities. */
  sessionAccess?: SessionAccessState;
  /** Explicit gateway read-only posture; absent preserves CLI behavior. */
  readOnly?: boolean;
  allowUnsandboxed?: boolean;
  /** Root-session-owned background shell capability. */
  backgroundShellRegistry?: BackgroundShellRegistryPort<BackgroundShellExecutionResult>;
  /** Root-session-owned output store + watch layer for background jobs. */
  backgroundShellOutput?: BackgroundShellOutputBundle;
  shellChildRegistry?: ShellChildRegistry;
  scopedSandbox?: import('../../tools/shell/sandbox/sandbox-policy.js').ScopedShellSandbox;
  /** False for one-shot/non-interactive callers until their lifecycle is supported. */
  allowBackgroundShell?: boolean;
  /** False for non-interactive / headless sessions where user prompts cannot be answered. */
  allowAskUser?: boolean;
  /** Explicit interactive-root-only browser capability. */
  sessionBrowser?: SessionBrowser;
  discordSend?: DiscordSend;
  isDiscordInputEnabled?: () => boolean;
  requestSessionRollover?: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome;
  configureTaskCheckIn?: (params: any) => any;
  setTaskCheckInPolicy?: (
    target: { kind: 'shell' | 'subagent'; id: string },
    options: { enabled?: boolean; intervalMs?: number },
  ) => void;
  mcpToolSource?: McpToolSource;
  snapshotGlobalMemoryContext?: (read: () => string) => string;
  worktreeScope?: ReadonlyArray<string>;
  worktreePaths?: Readonly<Record<string, string>>;
  listWorktreesSync?: ListWorktreesSync;
}

export interface AgentBuildResult {
  agent: ApplicationAgent;
  selection: ModelSelection;
}

const READ_ONLY_FILE_MUTATING_TOOLS = new Set(['apply_patch', 'create_file', 'search_replace']);

/** SDK-facing shim props attached to wrapped definitions by the factory; not part of the application contract. */
interface ToolInvokeShim {
  type: 'function';
  invoke: (context: unknown, input: unknown, details?: unknown) => Promise<unknown>;
}

function getToolCallId(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const toolCall = (details as { toolCall?: unknown }).toolCall;
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  const callId = (toolCall as { callId?: unknown }).callId;
  return typeof callId === 'string' ? callId : undefined;
}

export function buildAgentTools({
  toolDefinitions,
  resolvedModel,
  shouldUseNativePatchTool,
  deps,
}: {
  toolDefinitions: ToolRegistry;
  resolvedModel: string;
  shouldUseNativePatchTool: boolean;
  deps: AgentFactoryDeps;
}): ToolRegistry {
  for (const definition of toolDefinitions) {
    if (definition.postExecute && definition.postExecutePause) {
      throw new Error(
        `Tool ${definition.name} cannot define both postExecute and postExecutePause; compose them explicitly in postExecute.`,
      );
    }
  }
  const providerCapabilities = getProviderCapabilities(deps.providerId, deps.modelBinding);
  const useStrictToolSchema = shouldUseStrictToolSchema({
    providerId: deps.providerId,
    capabilities: providerCapabilities,
  });
  let tools: ToolRegistry = toolDefinitions
    .filter(() => true)
    .map((definition) => {
      const invoke = <T>(context: unknown, operation: () => Promise<T>): Promise<T> =>
        deps.withToolInvocation ? deps.withToolInvocation(definition.name, context, operation) : operation();
      const providerParameters = definition.strictParameters ?? definition.parameters;
      const canonicalParameters =
        definition.canonicalParameters ??
        (isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined);
      // Provider presentation may omit unavailable options. It must never
      // replace the schema that normalizes, validates, or authorizes execution.
      const wrappedDefinition: AnyToolDefinition = {
        ...definition,
        canonicalParameters,
        parallelSafe:
          typeof definition.parallelSafe === 'function'
            ? (params, context) =>
                invoke(context, async () =>
                  (definition.parallelSafe as (params: unknown, context?: unknown) => boolean | Promise<boolean>)(
                    params,
                    context,
                  ),
                )
            : definition.parallelSafe,
        postExecutePause: definition.postExecutePause
          ? {
              ...definition.postExecutePause,
              describe: (...args) =>
                shouldBypassToolApproval(definition.name, deps.settings.get('shell.autoApproveMode'))
                  ? null
                  : definition.postExecutePause!.describe(...args),
            }
          : undefined,
        parameters:
          useStrictToolSchema && isZodToolParameterSchema(providerParameters)
            ? // Strict-schema path: `parameters` is replaced at runtime by its JSON
              // schema form (the run loop's schema guard handles that). This is
              // an honest JSON-schema substitution, not an erased Zod schema.
              modelToolJsonSchema(toOpenAIStrictToolSchema(providerParameters))
            : definition.parameters,
        needsApproval: wrapNeedsApproval(
          {
            ...definition,
            ...(canonicalParameters ? { parameters: canonicalParameters } : {}),
            needsApproval: (params, context) => invoke(context, async () => definition.needsApproval(params, context)),
          },
          {
            checkInterceptors: (params) => deps.checkToolInterceptors(definition.name, params),
            toolName: definition.name,
            bypassApproval: () => shouldBypassToolApproval(definition.name, deps.settings.get('shell.autoApproveMode')),
            registry: deps.approvalPolicyRegistry,
          },
        ),
        execute: async (params, _context: unknown, details: unknown) => {
          const normalizedParams = normalizeToolParameters(params, canonicalParameters ?? definition.parameters);
          if (deps.readOnly && READ_ONLY_FILE_MUTATING_TOOLS.has(definition.name)) {
            return 'Error: file-mutating tool ' + definition.name + ' is unavailable in a read-only gateway session.';
          }
          const maxOutputLengthValue = deps.settings.get('shell.maxOutputChars');
          const toolCallId = getToolCallId(details);
          // Check if this execution should be intercepted
          const rejectionMessage = await deps.checkToolInterceptors(definition.name, normalizedParams, toolCallId);
          if (rejectionMessage) {
            deps.logger.debug('Tool execution intercepted', {
              tool: definition.name,
              params: JSON.stringify(normalizedParams).substring(0, 100),
            });
            // Return a failure response that all tools should understand
            const rejected = JSON.stringify({
              output: [
                {
                  success: false,
                  error: rejectionMessage,
                },
              ],
            });
            return trimToolOutput(rejected, undefined, maxOutputLengthValue ?? undefined);
          }

          const executeOriginal = () => {
            // The scripted gate accepts the physical start before entering this scope.
            const execute = () => invoke(_context, async () => definition.execute(normalizedParams, _context, details));
            return isScriptedToolCall(_context) && deps.executeScriptedTool
              ? deps.executeScriptedTool(
                  { toolName: definition.name, arguments: normalizedParams, context: _context, details },
                  execute,
                )
              : execute();
          };
          const result = await executeOriginal();
          const postExecute =
            definition.postExecute ??
            (isScriptedToolCall(_context) ||
            shouldBypassToolApproval(definition.name, deps.settings.get('shell.autoApproveMode'))
              ? undefined
              : deps.postExecutePauseCapability?.forTool(definition));
          const finalResult = postExecute
            ? await postExecute({
                params: normalizedParams,
                result,
                details,
                executeAgain: executeOriginal,
              })
            : result;
          // A scripted call's result goes to the script, not into model
          // context, so neither the trim nor its String() coercion applies.
          // Without this a tool returning fields reaches the script as the
          // literal "[object Object]". This precedes the preserveSerializedOutput
          // coercion: self-bounded tools (session browser) now return their
          // structured envelope on the scripted path, and String() would
          // flatten that object back to "[object Object]".
          if (isScriptedToolCall(_context)) {
            return finalResult;
          }
          if (definition.preserveSerializedOutput) {
            return String(finalResult ?? '');
          }
          const execution = getRunCodeExecutionResult(finalResult);
          const trimmedResult = trimToolOutput(
            execution && !Array.isArray(finalResult) ? String(finalResult) : finalResult,
            undefined,
            maxOutputLengthValue ?? undefined,
          );
          // Structured content-part results (read_file images) carry no single
          // text slot for the run-budget advisory; deliver them unmodified so
          // the image reaches the provider converter.
          const delivered =
            typeof trimmedResult === 'string' ? injectRunBudgetWarning(trimmedResult, _context) : trimmedResult;
          // Presentation transforms must retain run_code's application-owned
          // execution evidence for settlement and logical-tool observations.
          if (execution)
            return Object.defineProperty(Object(delivered), RUN_CODE_EXECUTION_RESULT, { value: execution });
          return delivered;
        },
      };
      // Validate arguments against the tool's own schema before execute, the
      // same guard the subagent registry applies in `tool-policy.ts`. Without
      // it a model response carrying empty or malformed arguments reached the
      // executor, which dereferenced a missing required field and returned a
      // raw TypeError the model could not act on. `wrapToolInvoke` turns that
      // into a schema diagnostic naming the offending fields.
      const validatedDefinition = wrapToolInvoke(wrappedDefinition, canonicalParameters, {
        argumentParsing: definition.argumentParsing,
      });
      const shim: ToolInvokeShim = {
        type: 'function',
        invoke: async (context: unknown, input: unknown, details?: unknown) => {
          const parsed = typeof input === 'string' ? JSON.parse(input) : input;
          return validatedDefinition.execute(parsed, context, details);
        },
      };
      const result = { ...validatedDefinition, ...shim };
      // Object spread evaluates accessors. Preserve run_code's late-bound
      // description accessor so the model receives the generated namespace
      // header after the complete wrapped registry is bound below.
      const descriptionDescriptor = Object.getOwnPropertyDescriptor(definition, 'description');
      if (descriptionDescriptor?.get) Object.defineProperty(result, 'description', descriptionDescriptor);
      return result;
    });

  // Native freeform apply_patch is a model-facing grammar. Scripts can only
  // pass JSON, so a graph that also exposes run_code keeps the custom JSON
  // definition bound into the script registry and never installs native.
  const hasRunCode = tools.some((tool) => tool.name === TOOL_NAME_RUN_CODE);
  if (shouldUseNativePatchTool && !hasRunCode) {
    const applyPatchIndex = tools.findIndex((tool) => tool.name === 'apply_patch');
    const applyPatch = applyPatchIndex >= 0 ? tools[applyPatchIndex] : undefined;
    if (applyPatch) {
      const nativeApplyPatch: AnyToolDefinition = {
        ...applyPatch,
        description:
          'The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
        modelTool: {
          type: 'custom',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: UPSTREAM_APPLY_PATCH_GRAMMAR,
          },
        },
        parseModelArguments: freeformApplyPatchArguments,
      };
      tools = tools.map((tool, index) => (index === applyPatchIndex ? nativeApplyPatch : tool));
      // The wrapped needsApproval returns true whenever a policy registry is
      // present, leaving the real decision in the registry for run_code. The
      // direct run loop calls the tool, so native calls must consult that
      // same registration instead of a second operations-shaped policy.
      nativeApplyPatch.needsApproval = async (params, context) => {
        if (shouldBypassToolApproval(nativeApplyPatch.name, deps.settings.get('shell.autoApproveMode'))) return false;
        const decision = await deps.approvalPolicyRegistry.evaluate({
          toolName: nativeApplyPatch.name,
          args: params,
          context,
        });
        return decision.kind !== 'auto_approve' && decision.kind !== 'interceptor_denied';
      };
    }
    deps.logger.debug('Using native applyPatchTool from SDK', {
      model: resolvedModel,
      provider: deps.providerId,
    });
  } else {
    deps.logger.debug('Using custom apply_patch implementation', {
      model: resolvedModel,
      provider: deps.providerId,
    });
  }

  // run_code executes tools itself, out of band of the run loop. Binding the
  // wrapped list here is what subjects a script's calls to the same approval
  // wrapping, plan-mode interceptors, and post-execute policy as a direct call.
  deps.onToolGraph?.(tools);
  bindRunCodeRegistry(tools);

  // Profiles without run_code keep their existing direct surface. When the
  // script path exists, file tools and shell keep the same wrapped validation,
  // approvals and execution on either surface. Workflow tools cannot be scripted.
  if (!hasRunCode) return tools;
  return tools.filter(isDirectlyCallable);
}

export function buildAgent(
  {
    selection,
    reasoningEffort,
    temperature,
  }: {
    selection: ModelSelection;
    reasoningEffort?: ReasoningEffortSetting | null;
    temperature?: number;
  },
  deps: AgentFactoryDeps,
): AgentBuildResult {
  const resolvedSelection = ModelSelectionSchema.parse(selection);
  deps = { ...deps, providerId: resolvedSelection.provider };
  const resolvedModel = resolvedSelection.model;
  const resolvedTemperature = temperature ?? deps.settings.get('agent.temperature');
  const {
    name,
    instructions,
    resolveInstructionsForRequest,
    resolvePersonalContext,
    resolveRequestSnapshot,
    memoryContextEnabled,
    tools: toolDefinitions,
  } = getAgentDefinition(
    {
      driverFactory: deps.driverFactory,
      modelBinding: deps.modelBinding,
      settingsService: deps.settings,
      loggingService: deps.logger,
      ...(deps.getGoal ? { getGoal: deps.getGoal } : {}),
      ...(deps.proposeGoal ? { proposeGoal: deps.proposeGoal } : {}),
      executionContext: deps.executionContext,
      approvalPolicyRegistry: deps.approvalPolicyRegistry,
      askMentor: deps.createMentor,
      runSubagent: deps.runSubagent,
      runSubagentAsync: deps.runSubagentAsync,
      getSubagentResult: deps.getSubagentResult,
      getSubagentStatus: deps.getSubagentStatus,
      sendSubagentMessage: deps.sendSubagentMessage,
      cancelSubagentRun: deps.cancelSubagentRun,
      runResolvedSubagent: deps.runResolvedSubagent,
      runResolvedSubagentAsync: deps.runResolvedSubagentAsync,
      getAskUserAnswer: deps.getAskUserAnswer,
      skillsService: deps.skillsService,
      includeMemory: deps.includeMemory,
      promptMemoryEnabled: deps.promptMemoryEnabled,
      onNativeToolSlots: deps.onNativeToolSlots,
      projectInstructions: deps.projectInstructions,
      agentRuntime: deps.getAgentRuntime?.() ?? null,
      postExecuteDeniedRead: Boolean(deps.postExecutePauseCapability),
      sessionAccess: deps.sessionAccess,
      readOnly: deps.readOnly,
      allowUnsandboxed: deps.allowUnsandboxed,
      backgroundShellRegistry: deps.backgroundShellRegistry,
      backgroundShellOutput: deps.backgroundShellOutput,
      shellChildRegistry: deps.shellChildRegistry,
      scopedSandbox: deps.scopedSandbox,
      allowBackgroundShell: deps.allowBackgroundShell,
      allowAskUser: deps.allowAskUser,
      sessionBrowser: deps.sessionBrowser,
      discordSend: deps.discordSend,
      isDiscordInputEnabled: deps.isDiscordInputEnabled,
      ...(deps.requestSessionRollover ? { requestSessionRollover: deps.requestSessionRollover } : {}),
      configureTaskCheckIn: deps.configureTaskCheckIn,
      setTaskCheckInPolicy: deps.setTaskCheckInPolicy,
      mcpToolSource: deps.mcpToolSource,
      snapshotGlobalMemoryContext: deps.snapshotGlobalMemoryContext,
      ...(deps.worktreeScope ? { worktreeScope: deps.worktreeScope } : {}),
      ...(deps.worktreePaths ? { worktreePaths: deps.worktreePaths } : {}),
      ...(deps.listWorktreesSync ? { listWorktreesSync: deps.listWorktreesSync } : {}),
    },
    resolvedModel,
  );

  const providerCapabilities = getProviderCapabilities(deps.providerId, deps.modelBinding);
  const shouldUseNativePatchToolForModel = shouldUseNativePatchToolPolicy({
    providerId: deps.providerId,
    model: resolvedModel,
    capabilities: providerCapabilities,
  });
  const tools = buildAgentTools({
    toolDefinitions,
    resolvedModel,
    shouldUseNativePatchTool: shouldUseNativePatchToolForModel,
    deps,
  });

  let effectiveReasoningEffort = reasoningEffort;
  const isDefaultSetting = deps.settings.get('agent.reasoningEffort') === 'default';
  if (isDefaultSetting && (!effectiveReasoningEffort || effectiveReasoningEffort === 'default')) {
    const defaultReasoningLevel =
      (deps.modelBinding
        ? deps.modelBinding.modelDefaultReasoningLevel(deps.providerId, resolvedModel, deps.settings)
        : getModelDefaultReasoningLevel(deps.providerId, resolvedModel)) ??
      (deps.modelBinding
        ? deps.modelBinding.providerDefaultReasoningLevel(deps.providerId)
        : getProviderDefaultReasoningLevel(deps.providerId));
    if (defaultReasoningLevel) {
      effectiveReasoningEffort = defaultReasoningLevel as ReasoningEffortSetting;
    }
  }

  const modelSettings = buildModelSettings({
    reasoningEffort: effectiveReasoningEffort,
    resolvedTemperature,
    resolvedModel,
    deps,
  });

  const agent: ApplicationAgent = {
    name,
    model: resolvedModel,
    ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
    instructions,
    ...(resolveInstructionsForRequest ? { resolveInstructionsForRequest } : {}),
    ...(resolvePersonalContext ? { resolvePersonalContext } : {}),
    ...(resolveRequestSnapshot ? { resolveRequestSnapshot } : {}),
    memoryContextEnabled,
    tools,
  };

  // Only add defaultRunOptions if an explicit effort is set (not
  // 'default'). This ensures the API receives the param only when
  // intended.
  if (effectiveReasoningEffort && effectiveReasoningEffort !== 'default') {
    agent.defaultRunOptions = { reasoning: { effort: effectiveReasoningEffort, summary: 'auto' } };
    agent.modelSettings = {
      ...(agent.modelSettings ?? {}),
      reasoning: { effort: effectiveReasoningEffort, summary: 'auto' },
    };
  }

  return { agent, selection: resolvedSelection };
}
