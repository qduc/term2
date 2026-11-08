/** Provider-facing settings and capability policy for one assembled agent. */
import type { NestedModelBinding } from '../../tools/nested-run-driver.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import type { ReasoningEffortSetting } from '../../tools/conversation.js';
import { getProvider, type ProviderDefinition } from '../../model/providers/index.js';
import { getCatalogModel } from '../../model/providers/model-catalog/catalog.js';
import {
  resolveModelContextPolicy,
  resolveOutputAllocation,
} from '../../session/agent-runtime/model-context-policy.js';

type AgentModelSettingsDeps = {
  readonly settings: ISettingsService;
  readonly providerId: string;
  readonly modelBinding?: NestedModelBinding;
  readonly serviceTierOverrideForNextRequest: 'standard' | null;
};

type ProviderCapabilities = NonNullable<ProviderDefinition['capabilities']>;

export function getProviderCapabilities(providerId: string, binding?: NestedModelBinding): ProviderCapabilities {
  return (
    (binding ? binding.providerDefinition(providerId) : getProvider(providerId))?.capabilities ?? {
      supportsConversationChaining: false,
    }
  );
}

export function buildModelSettings({
  reasoningEffort,
  resolvedTemperature,
  resolvedModel,
  deps,
}: {
  reasoningEffort?: ReasoningEffortSetting | null;
  resolvedTemperature?: number;
  resolvedModel: string;
  deps: AgentModelSettingsDeps;
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
    modelSettings.maxTokens = resolveOutputAllocation(
      getCatalogModel(deps.providerId, resolvedModel),
      maxOutputTokens,
      deps.settings.getSource?.('agent.maxOutputTokens') === 'default',
    );
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
    getProviderCapabilities(deps.providerId, deps.modelBinding).supportsFlexServiceTier === true
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
  const providerCapabilities = getProviderCapabilities(deps.providerId, deps.modelBinding);
  if (
    contextCompactionEnabled &&
    contextCompactionMode !== 'local' &&
    providerCapabilities.supportsContextCompaction === true
  ) {
    const configuredThreshold = deps.settings.get('agent.contextCompaction.compactThresholdTokens');
    const inputCeiling = deps.settings.get('agent.maxRequestInputTokens');
    const thresholdTokens =
      contextCompactionMode === 'auto'
        ? resolveModelContextPolicy({
            contextWindow: getCatalogModel(deps.providerId, resolvedModel)?.contextWindow,
            maxOutputTokens: modelSettings.maxTokens,
            inputLimit: inputCeiling,
            ratio: deps.settings.get('agent.contextCompaction.compactThreshold'),
            rawTrigger: configuredThreshold,
          }).softTrigger
        : configuredThreshold;
    modelSettings.providerData = {
      ...(modelSettings.providerData || {}),
      contextCompaction: {
        enabled: true,
        threshold: deps.settings.get('agent.contextCompaction.compactThreshold'),
        ...(thresholdTokens !== null && thresholdTokens !== undefined ? { thresholdTokens } : {}),
      },
    };
  }

  Object.assign(
    modelSettings,
    (deps.modelBinding
      ? deps.modelBinding.providerDefinition(deps.providerId)
      : getProvider(deps.providerId)
    )?.defaultModelSettings?.(),
  );

  return modelSettings;
}
