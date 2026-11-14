/**
 * "These arguments belong to another tool" hint for schema-mismatch results.
 *
 * Models occasionally call one tool with another tool's arguments (`shell` with read_file's `path`,
 * `start_line`, `end_line`). The schema diagnostic then only says `command must be string`, and the model
 * has to guess what went wrong. A registry holds the argument names of the tools one agent is offered;
 * when none of the received keys is one of the called tool's own and the keys fit one or two of those
 * tools, the diagnostic names them. The registry is per tool set, never global: a hint must not name a
 * tool the calling agent cannot call (a restricted subagent, a tool switched off). Error text only: the
 * call is never rerouted.
 */
import { FLAT_SEARCH_REPLACE_FIELDS } from './file/search-replace-protocol.js';

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

export class ToolArgumentNames {
  readonly #tools = new Map<string, { all: ReadonlySet<string>; required: readonly string[] }>();

  /** Record a tool's argument names. Ignored when the schema has no readable object shape. */
  register(toolName: string | undefined, schema: unknown): void {
    const shape = readShape(schema);
    if (!toolName || !shape) return;
    const names = Object.keys(shape);
    const required = names.filter((name) => {
      const field = shape[name];
      return typeof field?.safeParse === 'function' && !field.safeParse(undefined).success;
    });
    this.#tools.set(toolName, { all: new Set([...names, ...(ACCEPTED_ALIASES[toolName] ?? [])]), required });
  }

  /**
   * A sentence naming the tool the received arguments belong to, or '' when the call is not plainly another
   * offered tool's: some received key is the called tool's own, nothing registered fits, or more than two fit.
   */
  describeForeign(toolName: string, received: unknown): string {
    const own = this.#tools.get(toolName);
    if (!own || !received || typeof received !== 'object' || Array.isArray(received)) return '';
    const keys = Object.keys(received as Record<string, unknown>);
    if (keys.length === 0 || keys.some((key) => own.all.has(key))) return '';
    const owners = [...this.#tools.entries()]
      .filter(([name, entry]) => name !== toolName && keys.every((key) => entry.all.has(key)))
      .map(([name]) => name)
      .sort();
    if (owners.length === 0 || owners.length > 2) return '';
    const needs = own.required.length > 0 ? `; ${toolName} needs ${own.required.join(', ')}` : '';
    return `These arguments belong to ${owners.join(' or ')}, not ${toolName}${needs}.`;
  }
}
