/** Re-adapt one Session's existing memory leaves, without a second memory lifetime. */
import type { AnyToolDefinition } from '../../../source/tools/types.js';
import type { DirectContextCapabilities } from '../session/direct-capabilities.js';
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
      if (!capabilities.memory || capabilities.memory.tools.length === 0) return capabilities;
      const captured = capabilities.memory.tools.map((tool) => {
        const definition = definitions.get(tool.spec.name);
        if (!definition) throw new Error(`Cannot configure: native memory leaf '${tool.spec.name}' was not captured.`);
        return definition;
      });
      const tools = captured.map((definition) => surface.runtime.adaptTool(definition));
      return { ...capabilities, memory: { ...capabilities.memory, tools } };
    },
  };
}
