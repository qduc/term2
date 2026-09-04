import path from 'path';
import { z } from 'zod';
import type { ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import { getAgentDefinition } from '../agent.js';
import { getProvider } from '../providers/index.js';
import { createEditorImpl } from './editor-impl.js';
import { bindRunCodeRegistry, isDirectlyCallable, TOOL_NAME_RUN_CODE } from '../tools/system/run-code/index.js';
import { normalizeToolParameters, wrapNeedsApproval, wrapToolInvoke } from './tool-invoke.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ExecutionContext } from '../services/execution-context.js';
import { trimToolOutput } from '../utils/output/trim-tool-output.js';
import { isScriptedToolCall } from '../utils/output/bound-tool-result.js';
import { SkillsService } from '../services/skills/skills-service.js';
import { injectRunBudgetWarning } from '../utils/inject-warning-into-tool-output.js';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';
import {
  shouldUseNativePatchTool as shouldUseNativePatchToolPolicy,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';
import { getModelDefaultReasoningLevel, getProviderDefaultReasoningLevel } from '../services/model-service.js';
import { toolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import { shouldBypassToolApproval } from '../services/approval/shell-auto-approval-resolver.js';
import type { AgentRuntime } from '../services/agent-runtime/agent-runtime.js';
import {
  isZodToolParameterSchema,
  type AnyToolDefinition,
  type JsonSchemaObject,
  type PostExecutePauseCapability,
  type ToolRegistry,
} from '../tools/types.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';
import type { BackgroundShellOutputBundle } from '../services/shell/background-shell-watches.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';
import { getCatalogModel } from '../providers/model-catalog/catalog.js';
import type { ShellChildRegistry } from '../utils/shell/shell-child-registry.js';
import type { SessionBrowser } from '../services/conversation/session-browser.js';
import type { SessionRolloverRequest, SessionRolloverRequestOutcome } from '../contracts/session-rollover.js';
import { isProtectedHookPath, isWorkspacePathPhysicallyInside, resolveWorkspacePath } from '../tools/utils.js';
import { SANDBOX_TEMP_DIR } from '../utils/shell/temp-dir.js';
import { UPSTREAM_APPLY_PATCH_GRAMMAR, parseUpstreamApplyPatch } from '../tools/file/upstream-apply-patch.js';

export interface AgentFactoryDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  executionContext?: ExecutionContext;
  editor: ReturnType<typeof createEditorImpl>;
  providerId: string;
  serviceTierOverrideForNextRequest: 'standard' | null;
  createMentor: (task: string) => Promise<string>;
  runSubagent: (params: { role: string; task: string }) => Promise<{ finalText: string }>;
  runSubagentAsync: (params: { role: string; task: string }, context?: unknown, details?: unknown) => Promise<any>;
  getSubagentResult: (params: { runId: string }, context?: unknown, details?: unknown) => Promise<any>;
  getSubagentStatus?: (params: { runId?: string }, context?: unknown, details?: unknown) => any;
  sendSubagentMessage: (params: { target: string; message: string; reply_to?: string }) => any;
  cancelSubagentRun: (params: { target: string }) => any;
  getAskUserAnswer?: (callId?: string) => string | undefined;
  checkToolInterceptors: (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;
  skillsService?: SkillsService;
  /** Optional lazy bridge to the production one-shot agent runtime. */
  getAgentRuntime?: () => Pick<AgentRuntime, 'agent'> | null;
  /** Root-session-only policy capability for explicitly opted-in definitions. */
  postExecutePauseCapability?: PostExecutePauseCapability;
  /** Handle-owned state for root read and Docker capabilities. */
  sessionAccess?: SessionAccessState;
  /** Root-session-owned background shell capability. */
  backgroundShellRegistry?: BackgroundShellRegistry<BackgroundShellExecutionResult>;
  /** Root-session-owned output store + watch layer for background jobs. */
  backgroundShellOutput?: BackgroundShellOutputBundle;
  shellChildRegistry?: ShellChildRegistry;
  /** False for one-shot/non-interactive callers until their lifecycle is supported. */
  allowBackgroundShell?: boolean;
  /** False for non-interactive / headless sessions where user prompts cannot be answered. */
  allowAskUser?: boolean;
  /** Explicit interactive-root-only browser capability. */
  sessionBrowser?: SessionBrowser;
  requestSessionRollover?: (request: SessionRolloverRequest) => SessionRolloverRequestOutcome;
  configureTaskCheckIn?: (params: any) => any;
  setTaskCheckInPolicy?: (
    target: { kind: 'shell' | 'subagent'; id: string },
    options: { enabled?: boolean; intervalMs?: number },
  ) => void;
}

export interface AgentBuildResult {
  agent: ApplicationAgent;
  resolvedModel: string;
}

type ProviderCapabilities = {
  supportsConversationChaining: boolean;
  supportsContextCompaction?: boolean;
  supportsPromptCacheKey?: boolean;
  usesStrictToolSchema?: boolean;
  nativePatchModelPrefixes?: readonly string[];
};

function getProviderCapabilities(providerId: string): ProviderCapabilities {
  const providerDef = getProvider(providerId);
  return {
    supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
    supportsContextCompaction: providerDef?.capabilities?.supportsContextCompaction,
    supportsPromptCacheKey: providerDef?.capabilities?.supportsPromptCacheKey,
    usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
    nativePatchModelPrefixes: providerDef?.capabilities?.nativePatchModelPrefixes,
  };
}

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
  const providerCapabilities = getProviderCapabilities(deps.providerId);
  const useStrictToolSchema = shouldUseStrictToolSchema({
    providerId: deps.providerId,
    capabilities: providerCapabilities,
  });
  let tools: ToolRegistry = toolDefinitions
    .filter(() => true)
    .map((definition) => {
      const providerParameters = definition.strictParameters ?? definition.parameters;
      const wrappedDefinition: AnyToolDefinition = {
        ...definition,
        parameters:
          useStrictToolSchema && isZodToolParameterSchema(providerParameters)
            ? // Strict-schema path: `parameters` is replaced at runtime by its JSON
              // schema form (the run loop's schema guard handles that). This is
              // an honest JSON-schema substitution, not an erased Zod schema.
              (z.toJSONSchema(toOpenAIStrictToolSchema(providerParameters)) as JsonSchemaObject)
            : definition.parameters,
        needsApproval: wrapNeedsApproval(definition, {
          checkInterceptors: (params) => deps.checkToolInterceptors(definition.name, params),
          toolName: definition.name,
          bypassApproval: () => shouldBypassToolApproval(definition.name, deps.settings.get('shell.autoApproveMode')),
          registry: toolApprovalPolicyRegistry,
        }),
        execute: async (params, _context: unknown, details: unknown) => {
          const normalizedParams = normalizeToolParameters(params, definition.parameters);
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

          const executeOriginal = () => Promise.resolve(definition.execute(normalizedParams, _context, details));
          const result = await executeOriginal();
          const postExecute =
            definition.postExecute ??
            (shouldBypassToolApproval(definition.name, deps.settings.get('shell.autoApproveMode'))
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
          if (definition.preserveSerializedOutput) {
            return String(finalResult ?? '');
          }
          // A scripted call's result goes to the script, not into model
          // context, so neither the trim nor its String() coercion applies.
          // Without this a tool returning fields reaches the script as the
          // literal "[object Object]".
          if (isScriptedToolCall(_context)) {
            return finalResult;
          }
          const trimmedResult = trimToolOutput(finalResult, undefined, maxOutputLengthValue ?? undefined);
          // Structured content-part results (read_file images) carry no single
          // text slot for the run-budget advisory; deliver them unmodified so
          // the image reaches the provider converter.
          return typeof trimmedResult === 'string' ? injectRunBudgetWarning(trimmedResult, _context) : trimmedResult;
        },
      };
      // Validate arguments against the tool's own schema before execute, the
      // same guard the subagent registry applies in `tool-policy.ts`. Without
      // it a model response carrying empty or malformed arguments reached the
      // executor, which dereferenced a missing required field and returned a
      // raw TypeError the model could not act on. `wrapToolInvoke` turns that
      // into a schema diagnostic naming the offending fields.
      const validatedDefinition = wrapToolInvoke(
        wrappedDefinition,
        isZodToolParameterSchema(definition.parameters) ? definition.parameters : undefined,
        { argumentParsing: definition.argumentParsing },
      );
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
      const description = Object.getOwnPropertyDescriptor(definition, 'description');
      if (description?.get) Object.defineProperty(result, 'description', description);
      return result;
    });

  // The application-owned executor remains in the tool list, but capable
  // Responses providers receive its upstream custom/freeform declaration.
  if (shouldUseNativePatchTool) {
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
        parseModelArguments: parseUpstreamApplyPatch,
      };
      tools = tools.map((tool, index) => (index === applyPatchIndex ? nativeApplyPatch : tool));
      nativeApplyPatch.needsApproval = async (params, context) => {
        if (shouldBypassToolApproval(applyPatch.name, deps.settings.get('shell.autoApproveMode'))) return false;
        const rawOperations =
          params && typeof params === 'object' && Array.isArray((params as { operations?: unknown }).operations)
            ? (params as { operations: unknown[] }).operations
            : [params ?? context];
        const workspaceRoot = path.resolve(deps.executionContext?.getCwd() || process.cwd());
        for (const rawOperation of rawOperations) {
          if (!rawOperation || typeof rawOperation !== 'object') return true;
          const operation = rawOperation as { path?: unknown; type?: unknown; moveTo?: unknown };
          let resolved: string;
          try {
            resolved = resolveWorkspacePath(String(operation.path ?? ''), workspaceRoot);
          } catch {
            return true;
          }
          const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
          const insideWorkspace =
            (resolved !== workspaceRoot && resolved.startsWith(prefix)) ||
            resolved === SANDBOX_TEMP_DIR ||
            resolved.startsWith(SANDBOX_TEMP_DIR + path.sep);
          if (!insideWorkspace || isProtectedHookPath(resolved, workspaceRoot)) {
            if (!deps.sessionAccess?.allowsEdit(resolved, workspaceRoot)) return true;
          }
          if (operation.type === 'delete_file' || operation.moveTo) return true;
          if (deps.executionContext?.isRemote() && deps.executionContext.getSSHService()) return true;
          const physicallyInside =
            (await isWorkspacePathPhysicallyInside(resolved, workspaceRoot)) ||
            (await isWorkspacePathPhysicallyInside(resolved, SANDBOX_TEMP_DIR));
          if (!physicallyInside && !deps.sessionAccess?.allowsEdit(resolved, workspaceRoot)) return true;
        }
        return false;
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
  bindRunCodeRegistry(tools);

  // Profiles without shell do not register run_code. Keep their existing
  // direct surface intact; only reduce the model-facing list when run_code is
  // available as the script path.
  if (!tools.some((tool) => tool.name === TOOL_NAME_RUN_CODE)) return tools;

  // Keep the complete wrapped registry bound above, but make run_code the
  // primary model-facing path for tools that can execute without an
  // interactive boundary. Direct tools are either prohibited inside scripts
  // or may require approval for some parameter values.
  return tools.filter(isDirectlyCallable);
}

function buildModelSettings({
  reasoningEffort,
  resolvedTemperature,
  resolvedModel,
  deps,
}: {
  reasoningEffort?: ReasoningEffortSetting | null;
  resolvedTemperature?: number;
  resolvedModel: string;
  deps: AgentFactoryDeps;
}): Record<string, any> {
  // Build modelSettings only if an explicit effort value (other than
  // 'default') was provided. 'default' means we should not pass the
  // effort param and allow the underlying API to choose the default.
  const modelSettings: Record<string, any> = {
    retry: { maxRetries: deps.settings.get('agent.retryAttempts') ?? 2 },
  };
  const maxOutputTokens = deps.settings.get('agent.maxOutputTokens');
  const maxStreamOutputChars = deps.settings.get('agent.maxStreamOutputChars');
  const maxModelRequestDurationMs = deps.settings.get('agent.maxModelRequestDurationMs');
  const maxModelStreamIdleMs = deps.settings.get('agent.maxModelStreamIdleMs');
  if (typeof maxOutputTokens === 'number') {
    const catalogLimit = getCatalogModel(deps.providerId, resolvedModel)?.maxTokens;
    modelSettings.maxTokens = catalogLimit === undefined ? maxOutputTokens : Math.min(maxOutputTokens, catalogLimit);
  }
  if (typeof maxStreamOutputChars === 'number') modelSettings.maxStreamOutputChars = maxStreamOutputChars;
  if (typeof maxModelRequestDurationMs === 'number') {
    modelSettings.maxModelRequestDurationMs = maxModelRequestDurationMs;
  }
  if (typeof maxModelStreamIdleMs === 'number') {
    modelSettings.maxModelStreamIdleMs = maxModelStreamIdleMs;
  }
  if (reasoningEffort && reasoningEffort !== 'default') {
    modelSettings.reasoning = {
      effort: reasoningEffort,
      summary: 'auto',
    };
  }

  // Temperature: only pass when explicitly set (number). Undefined means
  // provider/model default.
  if (typeof resolvedTemperature === 'number' && Number.isFinite(resolvedTemperature)) {
    modelSettings.temperature = resolvedTemperature;
  }

  // OpenAI Flex Service Tier: only pass when enabled and using OpenAI provider
  // This reduces costs by using the flex service tier for lower priority requests
  // See: https://platform.openai.com/docs/guides/service-tier
  const useFlexServiceTier = deps.settings.get('agent.useFlexServiceTier');
  if (
    useFlexServiceTier &&
    deps.serviceTierOverrideForNextRequest !== 'standard' &&
    (deps.providerId === 'openai' || deps.providerId === 'openrouter')
  ) {
    modelSettings.providerData = {
      ...(modelSettings.providerData || {}),
      service_tier: 'flex',
    };
  }

  const contextCompactionEnabled = deps.settings.get('agent.contextCompaction.enabled');
  const contextCompactionMode = deps.settings.get('agent.contextCompaction.mode') ?? 'native';
  // Inline `context_management` is api.openai.com only. Codex uses POST
  // /responses/compact at the request boundary instead.
  const providerCapabilities = getProviderCapabilities(deps.providerId);
  if (
    contextCompactionEnabled &&
    contextCompactionMode !== 'local' &&
    providerCapabilities.supportsContextCompaction === true
  ) {
    const thresholdTokens = deps.settings.get('agent.contextCompaction.compactThresholdTokens');
    modelSettings.providerData = {
      ...(modelSettings.providerData || {}),
      contextCompaction: {
        enabled: true,
        threshold: deps.settings.get('agent.contextCompaction.compactThreshold'),
        ...(thresholdTokens !== null && thresholdTokens !== undefined ? { thresholdTokens } : {}),
      },
    };
  }

  if (deps.providerId === 'codex') {
    modelSettings.store = false;
    modelSettings.include = ['reasoning.encrypted_content'];
  }

  return modelSettings;
}

export function buildAgent(
  {
    model,
    reasoningEffort,
    temperature,
  }: {
    model?: string;
    reasoningEffort?: ReasoningEffortSetting | null;
    temperature?: number;
  },
  deps: AgentFactoryDeps,
): AgentBuildResult {
  const resolvedModel = model?.trim() || deps.settings.get('agent.model');
  const resolvedTemperature = temperature ?? deps.settings.get('agent.temperature');
  const {
    name,
    instructions,
    tools: toolDefinitions,
  } = getAgentDefinition(
    {
      settingsService: deps.settings,
      loggingService: deps.logger,
      executionContext: deps.executionContext,
      askMentor: deps.createMentor,
      runSubagent: deps.runSubagent,
      runSubagentAsync: deps.runSubagentAsync,
      getSubagentResult: deps.getSubagentResult,
      getSubagentStatus: deps.getSubagentStatus,
      sendSubagentMessage: deps.sendSubagentMessage,
      cancelSubagentRun: deps.cancelSubagentRun,
      getAskUserAnswer: deps.getAskUserAnswer,
      skillsService: deps.skillsService,
      agentRuntime: deps.getAgentRuntime?.() ?? null,
      postExecuteDeniedRead: Boolean(deps.postExecutePauseCapability),
      sessionAccess: deps.sessionAccess,
      backgroundShellRegistry: deps.backgroundShellRegistry,
      backgroundShellOutput: deps.backgroundShellOutput,
      shellChildRegistry: deps.shellChildRegistry,
      allowBackgroundShell: deps.allowBackgroundShell,
      allowAskUser: deps.allowAskUser,
      sessionBrowser: deps.sessionBrowser,
      ...(deps.requestSessionRollover ? { requestSessionRollover: deps.requestSessionRollover } : {}),
      configureTaskCheckIn: deps.configureTaskCheckIn,
      setTaskCheckInPolicy: deps.setTaskCheckInPolicy,
    },
    resolvedModel,
  );

  const providerCapabilities = getProviderCapabilities(deps.providerId);
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
      deps.providerId === 'codex'
        ? getModelDefaultReasoningLevel('codex', resolvedModel)
        : getProviderDefaultReasoningLevel(deps.providerId);
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
    tools,
  };

  // Only add defaultRunOptions if an explicit effort is set (not
  // 'default'). This ensures the API receives the param only when
  // intended.
  if (effectiveReasoningEffort && effectiveReasoningEffort !== 'default') {
    agent.defaultRunOptions = { reasoning: { effort: effectiveReasoningEffort } };
    agent.modelSettings = {
      ...(agent.modelSettings ?? {}),
      reasoning: { effort: effectiveReasoningEffort },
    };
  }

  return { agent, resolvedModel };
}
