import { Agent, tool as createTool, applyPatchTool, type Tool } from '@openai/agents';
import { type ModelSettingsReasoningEffort } from '@openai/agents-core/model';
import { getAgentDefinition } from '../agent.js';
import { getProvider } from '../providers/index.js';
import { createEditorImpl } from './editor-impl.js';
import { normalizeToolInput, toolErrorFunction, wrapNeedsApproval, wrapToolInvoke } from './tool-invoke.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { ExecutionContext } from '../services/execution-context.js';
import { trimToolOutput } from '../utils/output/trim-tool-output.js';
import { injectWarningIntoToolOutput } from '../utils/inject-warning-into-tool-output.js';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';
import {
  shouldUseNativePatchTool as shouldUseNativePatchToolPolicy,
  shouldUseStrictToolSchema,
} from './tool-selection-policy.js';
import { getModelDefaultReasoningLevel } from '../services/model-service.js';

export interface AgentFactoryDeps {
  settings: ISettingsService;
  logger: ILoggingService;
  executionContext?: ExecutionContext;
  editor: ReturnType<typeof createEditorImpl>;
  providerId: string;
  serviceTierOverrideForNextRequest: 'standard' | null;
  createMentor: (task: string) => Promise<string>;
  runSubagent: (params: { role: string; task: string }) => Promise<{ finalText: string }>;
  getAskUserAnswer: (callId?: string) => string | undefined;
  checkToolInterceptors: (name: string, params: unknown, toolCallId?: string) => Promise<string | null>;
}

export interface AgentBuildResult {
  agent: Agent;
  resolvedModel: string;
}

type ProviderCapabilities = {
  supportsConversationChaining: boolean;
  supportsTracingControl: boolean;
  supportsPromptCacheKey?: boolean;
  usesStrictToolSchema?: boolean;
  nativePatchModelPrefixes?: string[];
};

function getProviderCapabilities(providerId: string): ProviderCapabilities {
  const providerDef = getProvider(providerId);
  return {
    supportsConversationChaining: providerDef?.capabilities?.supportsConversationChaining ?? false,
    supportsTracingControl: providerDef?.capabilities?.supportsTracingControl ?? false,
    supportsPromptCacheKey: providerDef?.capabilities?.supportsPromptCacheKey,
    usesStrictToolSchema: providerDef?.capabilities?.usesStrictToolSchema,
    nativePatchModelPrefixes: providerDef?.capabilities?.nativePatchModelPrefixes,
  };
}

function buildAgentTools({
  toolDefinitions,
  resolvedModel,
  shouldUseNativePatchTool,
  deps,
}: {
  toolDefinitions: any[];
  resolvedModel: string;
  shouldUseNativePatchTool: boolean;
  deps: AgentFactoryDeps;
}): Tool[] {
  const providerCapabilities = getProviderCapabilities(deps.providerId);
  const useStrictToolSchema = shouldUseStrictToolSchema({
    providerId: deps.providerId,
    capabilities: providerCapabilities,
  });
  const tools: Tool[] = toolDefinitions
    .filter((definition) => {
      // Exclude custom apply_patch if we're using native one
      if (shouldUseNativePatchTool && definition.name === 'apply_patch') {
        return false;
      }
      return true;
    })
    .map((definition) =>
      wrapToolInvoke(
        createTool({
          name: definition.name,
          description: definition.description,
          parameters: useStrictToolSchema ? toOpenAIStrictToolSchema(definition.parameters) : definition.parameters,
          // Let schema-validation errors propagate to wrapToolInvoke for Zod
          // diagnostics; keep other runtime errors as non-fatal strings.
          errorFunction: toolErrorFunction,
          needsApproval: wrapNeedsApproval(definition, {
            checkInterceptors: (params) => deps.checkToolInterceptors(definition.name, params),
          }),
          execute: async (params, _context, details) => {
            const maxOutputLengthValue = deps.settings.get<number | undefined>('shell.maxOutputChars');
            // Extract tool call ID from details if available
            const toolCallId = details?.toolCall?.callId;
            // Check if this execution should be intercepted
            const rejectionMessage = await deps.checkToolInterceptors(definition.name, params, toolCallId);
            if (rejectionMessage) {
              deps.logger.debug('Tool execution intercepted', {
                tool: definition.name,
                params: JSON.stringify(params).substring(0, 100),
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

            const result = await definition.execute(params, _context, details);
            let trimmedResult = trimToolOutput(result, undefined, maxOutputLengthValue ?? undefined);

            // Inject warning when turns are approaching maxTurns
            const userContext: any = _context?.context;
            if (userContext && typeof userContext.turnCount === 'number' && typeof userContext.maxTurns === 'number') {
              const turnsLeft = userContext.maxTurns - userContext.turnCount;
              if (turnsLeft >= 0 && turnsLeft <= 5) {
                const warning = `\n\n[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
                trimmedResult = injectWarningIntoToolOutput(trimmedResult, warning);
              }
            }

            return trimmedResult;
          },
        }),
        definition.parameters,
        { argumentParsing: definition.argumentParsing },
      ),
    );

  // Add native applyPatchTool for gpt-5.1 on OpenAI provider
  if (shouldUseNativePatchTool) {
    const nativePatchTool = applyPatchTool({
      editor: deps.editor,
      needsApproval: false, // Default to auto-approve for now
    }) as any; // Type assertion needed as invoke is not in public API

    // Wrap the native tool's invoke function to apply interceptor check
    const originalInvoke = nativePatchTool.invoke;
    if (originalInvoke) {
      nativePatchTool.invoke = async (runContext: any, input: any, details: any) => {
        // Extract tool call ID from details if available
        const toolCallId = details?.toolCall?.callId;
        // Parse input to get params for logging
        const normalizedInput = normalizeToolInput(input);
        let params: any;
        try {
          params = typeof input === 'string' ? JSON.parse(input) : input;
        } catch {
          params = input;
        }
        const rejectionMessage = await deps.checkToolInterceptors('apply_patch', params, toolCallId);
        if (rejectionMessage) {
          deps.logger.debug('Native tool execution intercepted', {
            tool: 'apply_patch',
            toolCallId,
            params: JSON.stringify(params).substring(0, 100),
          });
          const rejected = JSON.stringify({
            output: [
              {
                success: false,
                error: rejectionMessage,
              },
            ],
          });
          const maxOutputLengthValue = deps.settings.get<number | undefined>('shell.maxOutputChars');
          return trimToolOutput(rejected, undefined, maxOutputLengthValue ?? undefined);
        }
        const maxOutputLengthValue = deps.settings.get<number | undefined>('shell.maxOutputChars');
        const result = await originalInvoke.call(nativePatchTool, runContext, normalizedInput, details);
        let trimmedResult = trimToolOutput(result, undefined, maxOutputLengthValue ?? undefined);

        // Inject warning when turns are approaching maxTurns
        const userContext: any = runContext?.context;
        if (userContext && typeof userContext.turnCount === 'number' && typeof userContext.maxTurns === 'number') {
          const turnsLeft = userContext.maxTurns - userContext.turnCount;
          if (turnsLeft >= 0 && turnsLeft <= 5) {
            const warning = `\n\n[Warning: You are approaching the maximum turn limit. You have ${turnsLeft} turns left. Please prepare to wrap up your work and provide a situation update message describing what has been completed and what remains to be done.]`;
            trimmedResult = injectWarningIntoToolOutput(trimmedResult, warning);
          }
        }

        return trimmedResult;
      };
    }

    tools.push(nativePatchTool);
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
  deps,
}: {
  reasoningEffort?: ModelSettingsReasoningEffort | 'default';
  resolvedTemperature?: number;
  deps: AgentFactoryDeps;
}): Record<string, any> {
  // Build modelSettings only if an explicit effort value (other than
  // 'default') was provided. 'default' means we should not pass the
  // effort param and allow the underlying API to choose the default.
  const modelSettings: Record<string, any> = {
    retry: { maxRetries: 0 },
  };
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
  const useFlexServiceTier = deps.settings.get<boolean>('agent.useFlexServiceTier');
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
    reasoningEffort?: ModelSettingsReasoningEffort | 'default';
    temperature?: number;
  },
  deps: AgentFactoryDeps,
): AgentBuildResult {
  const resolvedModel = model?.trim() || deps.settings.get<string>('agent.model');
  const resolvedTemperature = temperature ?? deps.settings.get<number | undefined>('agent.temperature');
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
      getAskUserAnswer: deps.getAskUserAnswer,
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
  const isDefaultSetting = deps.settings.get<string>('agent.reasoningEffort') === 'default';
  if (
    deps.providerId === 'codex' &&
    isDefaultSetting &&
    (!effectiveReasoningEffort || effectiveReasoningEffort === 'default')
  ) {
    const defaultReasoningLevel = getModelDefaultReasoningLevel('codex', resolvedModel);
    if (defaultReasoningLevel) {
      effectiveReasoningEffort = defaultReasoningLevel as ModelSettingsReasoningEffort;
    }
  }

  const modelSettings = buildModelSettings({
    reasoningEffort: effectiveReasoningEffort,
    resolvedTemperature,
    deps,
  });

  const agent = new Agent({
    name,
    model: resolvedModel,
    ...(Object.keys(modelSettings).length > 0 ? { modelSettings } : {}),
    instructions,
    tools,
  });

  // Only add defaultRunOptions if an explicit effort is set (not
  // 'default'). This ensures the API receives the param only when
  // intended.
  if (effectiveReasoningEffort && effectiveReasoningEffort !== 'default') {
    (agent as any).defaultRunOptions = {
      ...((agent as any).defaultRunOptions || {}),
      // Pass through to underlying client for models that support it
      reasoning: { effort: effectiveReasoningEffort },
    };
  }

  return { agent, resolvedModel };
}
