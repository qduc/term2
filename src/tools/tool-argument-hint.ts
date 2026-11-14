/**
 * "These arguments belong to another tool" hint for schema-mismatch results.
 *
 * Models occasionally call one tool with another tool's arguments (`shell` with read_file's `path`,
 * `start_line`, `end_line`). The schema diagnostic then only says `command must be string`, and the model
 * has to guess what went wrong. The diagnostic is given the tools its agent is offered; when none of the
 * received keys is one of the called tool's own and the keys fit one or two of those tools, it names them.
 * The list is the caller's own offered set, never a global one: a hint must not name a tool the calling
 * agent cannot call (a restricted subagent, a tool switched off). Error text only: the call is never
 * rerouted.
 */
import { FLAT_SEARCH_REPLACE_FIELDS } from './file/search-replace-protocol.js';

/** The part of an offered tool definition the hint reads. */
export type OfferedTool = { name?: string; canonicalParameters?: unknown; parameters?: unknown };

type ZodLike = {
  shape?: Record<string, { safeParse?: (value: unknown) => { success: boolean } } | undefined>;
  _def?: { out?: unknown; schema?: unknown };
  def?: { out?: unknown; schema?: unknown };
};

/** Keys a tool accepts through input preprocessing although its schema does not list them. */
const ACCEPTED_ALIASES: Readonly<Record<string, readonly string[]>> = {
  search_replace: FLAT_SEARCH_REPLACE_FIELDS,
};

/** The object shape of a schema, looking through the preprocess/pipe wrappers canonical schemas use. */
function readShape(schema: unknown, depth = 0): NonNullable<ZodLike['shape']> | undefined {
  if (!schema || typeof schema !== 'object' || depth > 4) return undefined;
  const candidate = schema as ZodLike;
  if (candidate.shape && typeof candidate.shape === 'object') return candidate.shape;
  const def = candidate.def ?? candidate._def;
  return readShape(def?.out ?? def?.schema, depth + 1);
}

/** A tool's argument names (flat aliases included) and the ones its schema requires. */
function describeArguments(tool: OfferedTool): { all: ReadonlySet<string>; required: string[] } | undefined {
  const shape = readShape(tool.canonicalParameters ?? tool.parameters);
  if (!shape) return undefined;
  const names = Object.keys(shape);
  const required = names.filter((name) => {
    const field = shape[name];
    return typeof field?.safeParse === 'function' && !field.safeParse(undefined).success;
  });
  return { all: new Set([...names, ...(ACCEPTED_ALIASES[tool.name ?? ''] ?? [])]), required };
}

/**
 * A sentence naming the offered tool the received arguments belong to, or '' when the call is not plainly
 * another offered tool's: some received key is the called tool's own, nothing offered fits, or more than two do.
 */
export function describeForeignArguments(toolName: string, received: unknown, offered: readonly OfferedTool[]): string {
  const ownTool = offered.find((tool) => tool.name === toolName);
  const own = ownTool && describeArguments(ownTool);
  if (!own || !received || typeof received !== 'object' || Array.isArray(received)) return '';
  const keys = Object.keys(received as Record<string, unknown>);
  if (keys.length === 0 || keys.some((key) => own.all.has(key))) return '';
  const owners = offered
    .filter((tool) => tool.name !== toolName && keys.every((key) => describeArguments(tool)?.all.has(key)))
    .map((tool) => tool.name)
    .sort();
  if (owners.length === 0 || owners.length > 2) return '';
  const needs = own.required.length > 0 ? `; ${toolName} needs ${own.required.join(', ')}` : '';
  return `These arguments belong to ${owners.join(' or ')}, not ${toolName}${needs}.`;
}
