import type { ToolRegistry } from '../../tools/types.js';
import { RUN_CODE_PROHIBITED_TOOLS, TOOL_NAME_RUN_CODE } from '../../tools/system/run-code/script-surface.js';

export function createUnknownToolHints(
  allTools: ToolRegistry,
  directToolNames: readonly string[],
): Readonly<Record<string, string>> {
  const names = new Set(allTools.map((tool) => tool.name));
  const hints = Object.create(null) as Record<string, string>;
  for (const name of directToolNames) {
    if (name !== TOOL_NAME_RUN_CODE && RUN_CODE_PROHIBITED_TOOLS.has(name))
      hints[name] = 'This is a direct tool; call it outside run_code instead.';
  }
  if (names.has('apply_patch')) {
    for (const name of ['create_file', 'search_replace']) {
      if (!names.has(name)) hints[name] = 'Use apply_patch instead (use *** Add File: to create a file).';
    }
  }
  if (!names.has('apply_patch') && (names.has('create_file') || names.has('search_replace'))) {
    hints.apply_patch = `This tool is unavailable; use ${['create_file', 'search_replace']
      .filter((name) => names.has(name))
      .join(' or ')} instead.`;
  }
  return hints;
}

export function unknownToolMessage(
  name: string,
  registry: ToolRegistry,
  hints: Readonly<Record<string, string>>,
): string {
  const available = registry.map((entry) => entry.name).join(', ');
  const hint = Object.hasOwn(hints, name) ? ` ${hints[name]}` : '';
  return `Unknown tool "${name}". Available: ${available}.${hint}`;
}
