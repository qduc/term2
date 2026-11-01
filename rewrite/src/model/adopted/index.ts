import type { StreamedModelTurn } from '../../../../source/contracts/streamed-model-turn.js';
import type {
  ILoggingService,
  ISettingsService,
  ISessionContextService,
} from '../../../../source/services/service-interfaces.js';
import type { ProviderDefinition, ProviderRegistry } from '../../../../source/providers/registry.js';
import type { ProviderRequestCapture } from '../../../../source/providers/provider-request-capture.js';
import type { ProviderRetryInfo } from '../../../../source/providers/retrying-model.js';
import type { ContextCompactionSessionState } from '../../../../source/contracts/streamed-model-turn.js';
import type { Model, ModelRef, ModelRegistry } from '../index.js';
import { createAdoptedModelRegistry, forkAdoptedModelRegistry } from './registry.js';
import { adoptedModelConversion } from './conversion.js';

export interface AdoptedModelBinding {
  readonly model: Model;
  readonly original: StreamedModelTurn | Promise<StreamedModelTurn>;
  readonly providerId: string;
  readonly supportsConversationChaining: boolean;
  readonly supportsContextCompaction: boolean;
  readonly ownership: 'owned' | 'borrowed';
  /** Source provider metadata is intentionally available only through this adopted binding. */
  readonly provider: ProviderDefinition;
}

export interface AdoptedModelRegistry extends ModelRegistry {
  waitForReadSettlement(signal: AbortSignal): Promise<void>;
  readonly settingsService: ISettingsService;
  hasUnsettledReads(): boolean;
  trackDetachedRead(operation: Promise<unknown>): void;
  original(ref: ModelRef): AdoptedModelBinding;
  createIndependent(ref: ModelRef): AdoptedModelBinding;
  acquireHelper(
    ref: ModelRef,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): { readonly original: StreamedModelTurn | Promise<StreamedModelTurn>; release(): Promise<void> };
  providerDefinition(providerId: string): ProviderDefinition;
  fetchModels(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<readonly import('../../../../source/services/model-service.js').ModelInfo[]>;
  fetchScopedModels(
    providerId: string,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly signal?: AbortSignal;
    },
  ): Promise<readonly import('../../../../source/services/model-service.js').ModelInfo[]>;
  modelDefaultReasoningLevel(
    providerId: string,
    modelId: string,
    settingsService?: ISettingsService,
  ): string | undefined;
  providerDefaultReasoningLevel(providerId: string): string | undefined;
  createScoped(
    ref: ModelRef,
    deps: {
      readonly settingsService: ISettingsService;
      readonly loggingService: ILoggingService;
      readonly sessionContextService?: ISessionContextService;
    },
  ): AdoptedModelBinding;
  dispose(): Promise<void>;
}

export interface AdoptedModelRegistryOptions {
  readonly settingsService: ISettingsService;
  readonly loggingService: ILoggingService;
  readonly sessionContextService?: ISessionContextService;
  readonly retryAttempts?: number;
  readonly requestCapture?: ProviderRequestCapture;
  readonly contextCompactionSessionState?: ContextCompactionSessionState;
  readonly providerRegistry?: ProviderRegistry;
  readonly ownership?: 'owned' | 'borrowed';
  readonly onRetry?: (info?: ProviderRetryInfo) => void;
}

export { createAdoptedModelRegistry, forkAdoptedModelRegistry, adoptedModelConversion };
