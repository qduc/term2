import path from 'path';
import { z } from 'zod';
import type { ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type { ReasoningEffortSetting } from '../contracts/conversation.js';
import { getAgentDefinition } from '../agent.js';
import { getProvider } from '../providers/index.js';
import { createEditorImpl } from './editor-impl.js';
import { normalizeToolParameters, wrapNeedsApproval } from './tool-invoke.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ExecutionContext } from '../services/execution-context.js';
import { trimToolOutput } from '../utils/output/trim-tool-output.js';
import { SkillsService } from '../services/skills/skills-service.js';
import { injectTurnLimitWarning, resolveTurnLimitContext } from '../utils/inject-warning-into-tool-output.js';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';
import {
  shouldUseNativePatchTool as shouldUseNativePatchToolPolicy,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';
import { getModelDefaultReasoningLevel } from '../services/model-service.js';
import { toolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import type { AgentRuntime } from '../services/agent-runtime/agent-runtime.js';
import { isZodToolParameterSchema } from '../tools/types.js';
import { isWorkspacePathPhysicallyInside, resolveWorkspacePath } from '../tools/utils.js';
import type { AnyToolDefinition, JsonSchemaObject, PostExecutePauseCapability, ToolRegistry } from '../tools/types.js';
import type { SessionAccessState } from '../services/session/session-access-state.js';
import type { BackgroundShellRegistry } from '../services/shell/background-shell-registry.js';
import type { BackgroundShellExecutionResult } from '../tools/system/shell.js';
import { getCatalogModel } from '../providers/model-catalog/catalog.js';

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
  getAskUserAnswer: (callId?: string) => string | undefined;
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
  /** False for one-shot/non-interactive callers until their lifecycle is supported. */
  allowBackgroundShell?: boolean;
}

export interface AgentBuildResult {
  agent: ApplicationAgent;
  resolvedModel: string;
}

type ProviderCapabilities = {
  supportsConversationChaining: boolean;
  supportsPromptCacheKey?: boolean;
  usesStrictToolSchema?: boolean;
  nativePatchModelPrefixes?: string[];
};

function getProviderCapabilities(providerId: string): ProviderCapabilities {
  const providerDef = getProvider(providerId);
  return {
    supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
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
  const tools: ToolRegistry = toolDefinitions
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
          const postExecute = definition.postExecute ?? deps.postExecutePauseCapability?.forTool(definition);
          const finalResult = postExecute
            ? await postExecute({
                params: normalizedParams,
                result,
                details,
                executeAgain: executeOriginal,
              })
            : result;
          const trimmedResult = trimToolOutput(finalResult, undefined, maxOutputLengthValue ?? undefined);
          return injectTurnLimitWarning(trimmedResult, resolveTurnLimitContext(_context));
        },
      };
      const shim: ToolInvokeShim = {
        type: 'function',
        invoke: async (context: unknown, input: unknown, details?: unknown) => {
          const parsed = typeof input === 'string' ? JSON.parse(input) : input;
          return wrappedDefinition.execute(parsed, context, details);
        },
      };
      return { ...wrappedDefinition, ...shim };
    });

  // The application-owned apply_patch definition remains in the tool list.
  // Native SDK patch tools are intentionally no longer constructed here.
  if (shouldUseNativePatchTool) {
    const applyPatch = tools.find((tool) => tool.name === 'apply_patch');
    if (applyPatch) {
      applyPatch.needsApproval = async (params, context) => {
        const operation = context ?? params;
        const operationPath =
          operation && typeof operation === 'object' ? (operation as { path?: unknown }).path : undefined;
        const workspaceRoot = path.resolve(deps.executionContext?.getCwd() || process.cwd());
        let resolved: string;
        try {
          resolved = resolveWorkspacePath(String(operationPath ?? ''), workspaceRoot);
        } catch {
          // Preserve explicit approval for lexically outside paths.
          return true;
        }

        const prefix = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
        const insideWorkspace = resolved !== workspaceRoot && resolved.startsWith(prefix);
        if (!insideWorkspace) {
          return true;
        }

        // Native patch calls use the same physical boundary as application
        // tools; never auto-approve a path that follows an escaping symlink.
        // Remote symlink state is not visible through the local filesystem, so
        // remote writes require explicit approval.
        if (deps.executionContext?.isRemote() && deps.executionContext.getSSHService()) {
          return true;
        }
        return !(await isWorkspacePathPhysicallyInside(resolved, workspaceRoot));
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

  return tools;
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
  if (typeof maxOutputTokens === 'number') {
    const catalogLimit = getCatalogModel(deps.providerId, resolvedModel)?.maxTokens;
    modelSettings.maxTokens = catalogLimit === undefined ? maxOutputTokens : Math.min(maxOutputTokens, catalogLimit);
  }
  if (typeof maxStreamOutputChars === 'number') modelSettings.maxStreamOutputChars = maxStreamOutputChars;
  if (typeof maxModelRequestDurationMs === 'number') {
    modelSettings.maxModelRequestDurationMs = maxModelRequestDurationMs;
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
  if (contextCompactionEnabled && deps.providerId === 'openai') {
    modelSettings.providerData = {
      ...(modelSettings.providerData || {}),
      contextCompaction: {
        enabled: true,
        threshold: deps.settings.get('agent.contextCompaction.compactThreshold'),
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
      allowBackgroundShell: deps.allowBackgroundShell,
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
  if (
    deps.providerId === 'codex' &&
    isDefaultSetting &&
    (!effectiveReasoningEffort || effectiveReasoningEffort === 'default')
  ) {
    const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', resolvedModel);
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
