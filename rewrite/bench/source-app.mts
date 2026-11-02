/** Historical source-agent composition for benches; Session owns graph lifetime. */
import { buildAgent } from '../../source/lib/agent-factory.js';
import type { AnyToolDefinition } from '../../source/tools/types.js';
import { createAdoptedEngine, InvalidAdoptedInputError } from '../src/engine/adopted/index.js';
import { createOriginalToolCatalog } from '../src/engine/adopted/tool-catalog.js';
import { createLegacySettingsSource } from '../src/engine/adopted/settings.js';
import { turnPrompt } from '../src/session/adopted/turn-prompt.js';
import type { LegacyEngineOptions, LegacyEngineAssembly } from '../src/session/adopted/session-handle.js';
import { createAppSettings, type AppSettingsOptions } from '../src/app/settings.js';
import type { SettingsWriteMode } from '../src/config/scoped-settings.js';

/** Keep the real scoped writable settings binding separate from native startup. */
export function createBenchSettings(options: AppSettingsOptions & { readonly writeMode?: SettingsWriteMode } = {}) {
  const { writeMode = 'persistent', ...serviceOptions } = options;
  const { service } = createAppSettings(serviceOptions);
  return { service, source: createLegacySettingsSource(service, writeMode) };
}

/** Build each source generation once and publish its exact final tools into the engine catalog. */
export function createBenchEngine(options: LegacyEngineOptions) {
  const tools = createOriginalToolCatalog([]);
  let current: ReturnType<typeof buildAgent> | undefined;
  const assembleAgent: typeof buildAgent = (buildOptions, deps) => {
    const built = buildAgent(buildOptions, deps);
    tools.replaceGeneration(built.agent.tools as readonly AnyToolDefinition[]);
    current = built;
    return built;
  };
  const engine = createAdoptedEngine({
    deps: { models: options.models, tools, settings: options.settings },
    clientOptions: options.clientOptions,
    bindSessionClient: options.bindSessionClient,
    assembleAgent,
    refreshPreparedInput(input, agent) {
      // Codex may return a transformed agent object; use the one about to be validated.
      return { ...input, instructions: turnPrompt(agent).instructions };
    },
    validateTurnInput(input, agent, providerId) {
      if (
        input.model.provider !== providerId ||
        input.model.model !== agent.model ||
        input.instructions !== turnPrompt(agent).instructions ||
        (input.reasoning !== undefined && input.reasoning !== agent.modelSettings?.reasoning?.effort)
      ) {
        throw new InvalidAdoptedInputError();
      }
    },
  });
  return {
    engine,
    tools,
    turnPrompt() {
      if (!current) throw new Error('Agent assembly is not initialized');
      return turnPrompt(current.agent);
    },
  } satisfies LegacyEngineAssembly & { tools: typeof tools };
}
