/** Actual configure preparation. Session alone accepts/persists/installs a generation. */
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import type { ModelRef } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectContextCapabilities } from '../session/direct-capabilities.js';
import type { DirectAcceptedConfiguration } from '../session/direct-command-types.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { createNestedAuthorizer } from './direct-application-nested.js';
import { runPolicy } from './direct-application-policy.js';
import type { DirectConfigMemoryBinding } from './direct-config-memory.js';
import { borrowDirectConfigSurfaceOptions } from './direct-config-remote.js';
import { directMainMemoryEnabled } from './direct-memory.js';
import {
  createDirectConfigSettings,
  type DirectAppConfiguration,
  type DirectConfigurationIntent,
} from './direct-config-settings.js';
import { readDirectInputPreviewConfiguration } from './direct-input-preview.js';
import { createDirectVerificationOperations } from './direct-verifier.js';
import { withGenerationGuard } from './generation-guard.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

export type DirectConfiguredGeneration = {
  /** Effective values from the real source-built agent, not the user's raw patch. */
  readonly configuration: DirectAcceptedConfiguration;
  /** Persist alongside effective values to restore default-effort semantics on reopen. */
  readonly intent: DirectConfigurationIntent;
  readonly profile: DirectConversationRuntime['profile'];
  readonly settings: ProfileSelection['settings'];
  readonly surface: AgentSurface;
  readonly deps: Omit<DirectConversationRuntime['deps'], 'context'>;
  readonly request: DirectConversationRuntime['request'];
  readonly capabilities: DirectContextCapabilities;
  /** Discard before acceptance, or retire AFTER every user of this graph drains. */
  dispose(): Promise<void>;
};
export type DirectConfigurationOptions = {
  readonly context: DirectRuntimeContext;
  /** The current session's full settings, never application defaults. */
  readonly selection: ProfileSelection;
  readonly scope: SessionScope;
  readonly surfaceOptions: Omit<ToolSurfaceOptions, 'workspace'>;
  readonly configuration: DirectAppConfiguration;
  /** Already-created Session capabilities. Do not invoke the context factory again. */
  readonly capabilities: DirectContextCapabilities;
  readonly memoryBinding: DirectConfigMemoryBinding;
  /**
   * App/user authority, BEFORE assembly. Must refuse unauthorized billing/provider
   * transitions. No inferred authorization from model spelling or catalog presence.
   * Called even for the current selection, so policy revocation can fail closed.
   */
  readonly authorizeModel: (next: ModelRef, previous: ModelRef) => void | Promise<void>;
};

/**
 * Prepare a complete real model/tool/policy generation without provider/tool
 * execution, facts, record publication, or a second context/hooks/memory lifetime.
 * Session must discard on stale revision/append failure; after one durable
 * configure+receipt append it synchronously swaps root deps/request/capabilities
 * and app record pointers. Retain old graphs while background users still run.
 */
export async function prepareDirectConfiguration(
  options: DirectConfigurationOptions,
): Promise<DirectConfiguredGeneration> {
  const { settings, intent } = createDirectConfigSettings(options.selection.settings, options.configuration);
  const model = intent.modelSelection;
  await options.authorizeModel(model, options.context.model);
  const selection: ProfileSelection = { ...options.selection, settings };
  const context: DirectRuntimeContext = { ...options.context, model };
  const profile = getProfileMetadata(String(settings.get('app.activeProfileId')));
  const surface = loadSurface(
    selection,
    borrowDirectConfigSurfaceOptions({
      ...options.surfaceOptions,
      includeMemory: false,
      promptMemoryEnabled: context.workspace.target === 'local' && directMainMemoryEnabled(settings),
      workspace: context.workspace,
    }),
  );
  try {
    const models = withGenerationGuard(withSessionScope(createProviderRegistry(selection), options.scope), selection);
    // Resolve validates the actual application provider without dispatching a request.
    models.resolve(model);
    const rebound = {
      ...options.memoryBinding.rebind(surface, options.capabilities),
      nativeToolSlots: surface.runtime.nativeToolSlots,
      modelRollover: options.surfaceOptions.sessionBrowser === true && surface.runtime.nativeToolSlots.sessions,
    };
    // Remove prior model-bound verification rather than silently retaining it when disabled/remote.
    const { verification: _previousVerification, verificationEnabled: _previousEnabled, ...stable } = rebound;
    const verification =
      settings.get('agent.completionVerification') !== false && context.workspace.target === 'local'
        ? {
            operations: createDirectVerificationOperations({
              models,
              model: settings.get('verifier.model')
                ? { provider: model.provider, model: settings.get('verifier.model') }
                : model,
              workspace: context.workspace,
            }),
            ...(rebound.verification?.limits ? { limits: rebound.verification.limits } : {}),
          }
        : undefined;
    const { notice: _notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
    let disposed = false;
    return {
      configuration: {
        model,
        ...(surface.reasoning !== undefined ? { reasoning: surface.reasoning } : {}),
        ...(surface.temperature !== undefined ? { temperature: surface.temperature } : {}),
      },
      intent,
      profile: {
        id: profile.activeProfileId,
        version: profile.activeProfileVersion,
        digest: profile.activeProfileDigest,
      },
      settings,
      surface,
      deps: {
        models,
        tools: runtime.tools,
        toolContext: runtime.toolContext,
        maxParallelToolCalls: runtime.maxParallelToolCalls,
        ...runPolicy(settings, context.id, model),
        authorizeNested: createNestedAuthorizer(settings, model, runtime.resolveNestedAuthority),
      },
      request: {
        ...request,
        // Initial profile priming is not a reusable request notice. Accepted
        // transitions use the runtime planner/native one-shot field instead.
        previewMode: readDirectInputPreviewConfiguration(settings, model).mode,
      },
      capabilities: {
        ...stable,
        ...(verification ? { verification } : {}),
        verificationEnabled: () => settings.get('agent.completionVerification') !== false,
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await runtime.dispose?.();
      },
    };
  } catch (error) {
    try {
      await surface.runtime.dispose?.();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Configure preparation and candidate disposal failed.');
    }
    throw error;
  }
}
