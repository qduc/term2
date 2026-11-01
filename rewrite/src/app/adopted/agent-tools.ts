import { buildAgent, type AgentBuildResult, type AgentFactoryDeps } from '../../../../source/lib/agent-factory.js';
import type { AnyToolDefinition } from '../../../../source/tools/types.js';
import { createOriginalToolCatalog, type OriginalToolCatalog } from '../../engine/adopted/tool-catalog.js';
import { turnPrompt, type TurnPrompt } from '../../session/adopted/turn-prompt.js';

export type AppAgentBuildOptions = Parameters<typeof buildAgent>[0];

export type AppAgentToolAssembly = {
  /** The one real source build; app consumers reuse its instructions, model and tool selection. */
  readonly agentBuild: AgentBuildResult;
  /** Catalog of the exact final `agent.tools` objects in `agentBuild`. */
  readonly registry: OriginalToolCatalog;
  /** Resolve prompt data from this generation at each model request boundary. */
  readonly turnPrompt: () => TurnPrompt;
};

/** Build the application agent once, then catalog its final source tool graph. */
export function createAppToolRegistry(
  buildOptions: AppAgentBuildOptions,
  deps: AgentFactoryDeps,
): AppAgentToolAssembly {
  const agentBuild = buildAgent(buildOptions, deps);
  const definitions = agentBuild.agent.tools as readonly AnyToolDefinition[];
  return {
    agentBuild,
    registry: createOriginalToolCatalog(definitions),
    turnPrompt: () => turnPrompt(agentBuild.agent),
  };
}

/** Assemble each normal source generation once and publish its exact tools to a stable facade. */
export function createAppAgentAssembler(
  registry: OriginalToolCatalog,
): typeof buildAgent & { current(): AppAgentToolAssembly } {
  let current: AppAgentToolAssembly | undefined;
  const assemble: typeof buildAgent = (buildOptions, deps) => {
    const assembly = createAppToolRegistry(buildOptions, deps);
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
