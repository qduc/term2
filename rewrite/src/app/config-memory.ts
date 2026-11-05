/** Re-adapt one Session's existing memory leaves, without a second memory lifetime. */
import { isDirectlyCallable, TOOL_NAME_RUN_CODE } from '../../../source/tools/system/run-code/index.js';
import type { AnyToolDefinition } from '../../../source/tools/types.js';
import type { DirectContextCapabilities } from '../session/capabilities.js';
import type { AgentSurface } from './tool-contract.js';

export type DirectConfigMemoryBinding = ReturnType<typeof createDirectConfigMemoryBinding>;

/**
 * Create once, before the initial context factory builds memory. Capture the
 * SAME source leaves that factory offers; replay them against a new surface's
 * gates when configuring, retaining memory snapshots, stores and hooks.
 */
export function createDirectConfigMemoryBinding() {
  const definitions = new Map<string, AnyToolDefinition>();
  return {
    adapt(surface: AgentSurface, definition: AnyToolDefinition) {
      const tool = surface.runtime.adaptTool(definition);
      definitions.set(tool.spec.name, definition);
      return tool;
    },
    rebind(surface: AgentSurface, capabilities: DirectContextCapabilities): DirectContextCapabilities {
      if (!capabilities.memory || capabilities.memory.access === 'none') return capabilities;
      // Hidden scripted leaves still belong to every configured generation.
      const adapted = [...definitions.values()].map((definition) => surface.runtime.adaptTool(definition));
      const tools = surface.tools.some((tool) => tool.name === TOOL_NAME_RUN_CODE)
        ? adapted.filter((tool) => isDirectlyCallable(tool.spec))
        : adapted;
      return { ...capabilities, memory: { ...capabilities.memory, tools } };
    },
  };
}
