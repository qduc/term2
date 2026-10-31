import { buildAgent, type AgentBuildResult, type AgentFactoryDeps } from '../../../../source/lib/agent-factory.js';
import type { AnyToolDefinition } from '../../../../source/tools/types.js';
import {
  createAdoptedToolRegistry,
  type AdoptedToolRegistry,
  type AdoptedToolRegistryOptions,
} from '../../tools/adopted/index.js';
import { turnPrompt, type TurnPrompt } from '../../session/adopted/turn-prompt.js';

export type AppAgentBuildOptions = Parameters<typeof buildAgent>[0];

export type AppAgentToolAssembly = {
  /** The one real source build; app consumers reuse its instructions, model and tool selection. */
  readonly agentBuild: AgentBuildResult;
  /** Adapter over the exact final `agent.tools` objects in `agentBuild`. */
  readonly registry: AdoptedToolRegistry;
  /** Resolve prompt data from this generation at each model request boundary. */
  readonly turnPrompt: () => TurnPrompt;
};

/** Build the application agent once, then adapt its final source tool graph. */
export function createAppToolRegistry(
  buildOptions: AppAgentBuildOptions,
  deps: AgentFactoryDeps,
  adapterOptions: AdoptedToolRegistryOptions = {},
): AppAgentToolAssembly {
  const agentBuild = buildAgent(buildOptions, deps);
  const definitions = agentBuild.agent.tools as readonly AnyToolDefinition[];
  return {
    agentBuild,
    registry: createAdoptedToolRegistry(definitions, adapterOptions),
    turnPrompt: () => turnPrompt(agentBuild.agent),
  };
}

/** Assemble each normal source generation once and publish its exact tools to a stable facade. */
export function createAppAgentAssembler(
  registry: AdoptedToolRegistry,
  adapterOptions: AdoptedToolRegistryOptions = {},
): typeof buildAgent & { current(): AppAgentToolAssembly } {
  let current: AppAgentToolAssembly | undefined;
  const assemble: typeof buildAgent = (buildOptions, deps) => {
    const assembly = createAppToolRegistry(buildOptions, deps, adapterOptions);
    registry.replaceGeneration(assembly.agentBuild.agent.tools as readonly AnyToolDefinition[]);
    current = assembly;
    return assembly.agentBuild;
  };
  return Object.assign(assemble, {
    current: () => {
      if (!current) throw new Error('Agent assembly is not initialized');
      return current;
    },
  });
}
