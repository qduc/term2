import { buildAgent, type AgentBuildResult, type AgentFactoryDeps } from '../../../../source/lib/agent-factory.js';
import type { AnyToolDefinition } from '../../../../source/tools/types.js';
import {
  createAdoptedToolRegistry,
  type AdoptedToolRegistry,
  type AdoptedToolRegistryOptions,
} from '../../tools/adopted/index.js';

export type AppAgentBuildOptions = Parameters<typeof buildAgent>[0];

export type AppAgentToolAssembly = {
  /** The one real source build; app consumers reuse its instructions, model and tool selection. */
  readonly agentBuild: AgentBuildResult;
  /** Adapter over the exact final `agent.tools` objects in `agentBuild`. */
  readonly registry: AdoptedToolRegistry;
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
  };
}
