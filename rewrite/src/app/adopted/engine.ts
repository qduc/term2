import type { AgentClient } from '../../../../source/lib/agent-client.js';
import type { SettingsReader } from '../../config/index.js';
import { createAdoptedEngine, InvalidAdoptedInputError } from '../../engine/adopted/index.js';
import type { AdoptedModelRegistry } from '../../model/adopted/index.js';
import { createAdoptedToolRegistry, type AdoptedToolRegistryOptions } from '../../tools/adopted/index.js';
import { createAppAgentAssembler } from './agent-tools.js';
import { turnPrompt } from '../../session/adopted/turn-prompt.js';

/** Compose the normal application agent and the adopted engine around one tool generation. */
export function createAppAdoptedEngine(options: {
  readonly models: AdoptedModelRegistry;
  readonly settings: SettingsReader;
  readonly clientOptions: Omit<
    ConstructorParameters<typeof AgentClient>[0],
    | 'driverFactory'
    | 'modelBinding'
    | 'adoptedProviderBinding'
    | 'assembleAgent'
    | 'selectApplicationAgent'
    | 'validateApplicationAgent'
    | 'agentOverride'
  >;
  readonly toolOptions?: AdoptedToolRegistryOptions;
}) {
  const tools = createAdoptedToolRegistry([], options.toolOptions);
  const assembleAgent = createAppAgentAssembler(tools, options.toolOptions);
  const engine = createAdoptedEngine({
    deps: { models: options.models, tools, settings: options.settings },
    clientOptions: options.clientOptions,
    assembleAgent,
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
  return { engine, tools, turnPrompt: () => assembleAgent.current().turnPrompt() };
}
