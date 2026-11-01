import type { AnyToolDefinition } from '../../../../source/tools/types.js';

/** Source definitions used by the historical engine, not native executable tools. */
export type OriginalToolCatalog = {
  original(name: string): AnyToolDefinition | undefined;
  /** Resolve configured offered names in their supplied offering order. */
  originals(names: readonly string[]): readonly AnyToolDefinition[];
  replaceGeneration(definitions: readonly AnyToolDefinition[]): void;
};

/** Preserve source identity and offering order; reject duplicate generations atomically. */
export function createOriginalToolCatalog(definitions: readonly AnyToolDefinition[]): OriginalToolCatalog {
  let originals = new Map<string, AnyToolDefinition>();
  const replaceGeneration = (next: readonly AnyToolDefinition[]) => {
    const nextOriginals = new Map<string, AnyToolDefinition>();
    for (const definition of next) {
      if (nextOriginals.has(definition.name)) throw new Error(`Duplicate assembled tool name: ${definition.name}`);
      nextOriginals.set(definition.name, definition);
    }
    originals = nextOriginals;
  };
  replaceGeneration(definitions);
  return {
    original: (name) => originals.get(name),
    replaceGeneration,
    originals: (names) =>
      names.map((name) => {
        const definition = originals.get(name);
        if (!definition) throw new Error(`Configured tool "${name}" is missing from the assembled tool registry`);
        return definition;
      }),
  };
}
