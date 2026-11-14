/**
 * "These arguments belong to another tool" hint for schema-mismatch results.
 *
 * Models occasionally call one tool with another tool's arguments (`shell` with read_file's `path`,
 * `start_line`, `end_line`). The schema diagnostic then only says `command must be string`, and the model
 * has to guess what went wrong. Tools register their argument names as they are wrapped; when none of the
 * received keys is one of the called tool's own and the keys fit another registered tool, the diagnostic
 * names that tool. Error text only: the call is never rerouted.
 */

const toolKeys = new Map<string, { all: ReadonlySet<string>; required: readonly string[] }>();

type ZodLike = {
  shape?: Record<string, { safeParse?: (value: unknown) => { success: boolean } } | undefined>;
  _def?: { out?: unknown; schema?: unknown };
  def?: { out?: unknown; schema?: unknown };
};

/** The object shape of a schema, looking through the preprocess/pipe wrappers canonical schemas use. */
function readShape(schema: unknown, depth = 0): NonNullable<ZodLike['shape']> | undefined {
  if (!schema || typeof schema !== 'object' || depth > 4) return undefined;
  const candidate = schema as ZodLike;
  if (candidate.shape && typeof candidate.shape === 'object') return candidate.shape;
  const def = candidate.def ?? candidate._def;
  return readShape(def?.out ?? def?.schema, depth + 1);
}

/** Record a tool's argument names. Ignored when the schema has no readable object shape. */
export function registerToolArgumentNames(toolName: string | undefined, schema: unknown): void {
  const shape = readShape(schema);
  if (!toolName || !shape) return;
  const names = Object.keys(shape);
  const required = names.filter((name) => {
    const field = shape[name];
    return typeof field?.safeParse === 'function' && !field.safeParse(undefined).success;
  });
  toolKeys.set(toolName, { all: new Set(names), required });
}

/**
 * A sentence naming the tool the received arguments belong to, or '' when the call is not plainly another
 * tool's: some received key is the called tool's own, nothing registered fits, or more than two tools fit.
 */
export function describeForeignArguments(toolName: string, received: unknown): string {
  const own = toolKeys.get(toolName);
  if (!own || !received || typeof received !== 'object' || Array.isArray(received)) return '';
  const keys = Object.keys(received as Record<string, unknown>);
  if (keys.length === 0 || keys.some((key) => own.all.has(key))) return '';
  const owners = [...toolKeys.entries()]
    .filter(([name, entry]) => name !== toolName && keys.every((key) => entry.all.has(key)))
    .map(([name]) => name)
    .sort();
  if (owners.length === 0 || owners.length > 2) return '';
  const needs = own.required.length > 0 ? `; ${toolName} needs ${own.required.join(', ')}` : '';
  return `These arguments belong to ${owners.join(' or ')}, not ${toolName}${needs}.`;
}
