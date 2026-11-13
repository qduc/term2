import { SHELL_DELEGATION_POINTER } from '../../tools/system/shell.js';
import type { AnyToolDefinition } from '../../tools/types.js';

const RUN_CODE = 'run_code';
const RUN_SUBAGENT = 'run_subagent';

/**
 * Clauses that point at the `run_code` script surface (`tools.<name>(...)`),
 * each matched with its own delimiter so deleting it leaves the surrounding
 * sentence intact:
 * - ` (inside run_code, use tools.grep(...))`; not ` (inside run_code, use shell)`, a
 *   redirect that stays true for a child offered `shell` directly
 * - ` (use tools.code_context_search(...) inside run_code)`, ` (use tools.glob(...))`
 * - `; inside run_code, use tools.read_file(...)` before the sentence's full stop
 * - ` (more from inside run_code)`
 */
const SCRIPT_SURFACE_CLAUSES: readonly RegExp[] = [
  / \((?:inside run_code, use tools\.\w+\(\.\.\.\)(?: instead)?|use tools\.\w+\(\.\.\.\)(?: inside run_code)?)\)/g,
  /; inside run_code, use tools\.\w+\(\.\.\.\)(?: instead)?(?=\.)/g,
  / \(more from inside run_code\)/g,
];

/**
 * Tool descriptions are written for the root surface, where `run_code` and
 * `run_subagent` exist. A child that was not offered one of them would be
 * pointed at a tool it cannot call, so those pointers are deleted from the
 * child's copy.
 *
 * Availability is read from the child's final tool list, never from its role.
 * Only whole pointer clauses are deleted; nothing is reworded or redirected to
 * another tool. A pointer whose deletion would change what the remaining
 * sentence says (web_fetch's "referenced by tools.web_search(...) inside
 * run_code or by the user") does not match and is left as written.
 */
export function withoutDeadToolReferences<T extends Pick<AnyToolDefinition, 'name' | 'description'>>(
  tools: readonly T[],
): T[] {
  const offered = new Set(tools.map((tool) => tool.name));
  return tools.map((tool) => {
    if (typeof tool.description !== 'string') return tool;
    let description = tool.description;
    if (tool.name === 'shell' && !offered.has(RUN_SUBAGENT)) {
      description = description.replace(SHELL_DELEGATION_POINTER, '');
    }
    if (!offered.has(RUN_CODE)) {
      description = SCRIPT_SURFACE_CLAUSES.reduce((text, clause) => text.replace(clause, ''), description);
    }
    return description === tool.description ? tool : { ...tool, description };
  });
}
