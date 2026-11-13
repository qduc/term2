/**
 * Recoverable `run_subagent` argument shapes.
 *
 * Real runs showed a model's first call mixing the two documented shapes: a
 * read-only `explorer` (with or without `task`) plus an `agent_spec`, or
 * agent_spec fields (`doneWhen`, `tools`) at the top level. The schema rejected
 * those and every retry but one asked for the named role with a task, costing a
 * provider request each time. All 48 recorded rejections named `explorer`.
 *
 * Only a read-only role (explorer, librarian) is rewritten, and only when every
 * spec field is either text for the child or a limit we may drop because the
 * role cannot write: a writing role, or any scope, model or unknown field the
 * model may rely on, keeps the rejection that names the one shape to send. The
 * rewritten call is plain `role` + `task`, so it grants exactly what that role
 * grants alone. The canonical schema still validates the rewritten call.
 */
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { normalizeObjectParams } from '../tool-invoke.js';
import { safeJsonParse } from '../format-helpers.js';

/** Tools each rewritable role is offered, in agent_spec's vocabulary (`can*` frontmatter of its role prompt). */
const READ_ONLY_ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  explorer: [
    'read_file',
    'grep',
    'glob',
    'read_code_outline',
    'code_context_search',
    'web_search',
    'web_fetch',
    'shell',
  ],
  librarian: [],
};

type Shape =
  | { readonly ok: true; readonly value: unknown; readonly interpretation?: string }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** A tool list sent as an array or a JSON array string; anything else is malformed. */
function toolList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

/** Constraints as an array of strings or one string; anything else is malformed. */
function constraintList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

const positiveInt = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;

// The diagnostic keeps about 160 characters of this message, so the instruction comes first.
const reject = (reason: string): Shape => ({
  ok: false,
  message: `Send role+task without agent_spec, or agent_spec alone (${reason})`,
});

type Pieces = { goal?: string; constraints: string[]; doneWhen?: string; context?: Record<string, unknown> };

/**
 * Text fields to append and limits to drop, or the reason the spec must be sent as its own shape.
 * Dropped: a tool list within the role's own tools, `budget`, `permissions.tools` within the role's
 * tools, `permissions.agents.maxDepth`, and `permissions.readOnly: true` — none can widen what a
 * read-only role does. Rejected: everything else, including filesystem and network scopes, which the
 * model may rely on for safety and which the role would not enforce.
 */
function readSpec(role: string, spec: Record<string, unknown>, source: string): Pieces | string {
  const allowed = READ_ONLY_ROLE_TOOLS[role]!;
  const pieces: Pieces = { constraints: [] };
  const toolsWithin = (value: unknown, field: string): string | undefined => {
    const tools = toolList(value);
    if (!tools) return `${field} must be a list of tool names`;
    const missing = tools.filter((tool) => !allowed.includes(tool));
    return missing.length ? `${field} asks for ${missing.join(', ')}, which ${role} lacks` : undefined;
  };
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined) continue;
    if (key === 'goal' || key === 'doneWhen') {
      if (typeof value !== 'string') return `${source}.${key} must be a string`;
      if (key === 'goal') pieces.goal = value;
      else pieces.doneWhen = value;
    } else if (key === 'constraints') {
      const list = constraintList(value);
      if (!list) return `${source}.constraints must be strings`;
      pieces.constraints = list.filter(nonEmpty).map((line) => line.trim());
    } else if (key === 'context') {
      if (!isRecord(value)) return `${source}.context must be an object`;
      pieces.context = value;
    } else if (key === 'tools') {
      const problem = toolsWithin(value, `${source}.tools`);
      if (problem) return problem;
    } else if (key === 'budget') {
      if (
        !isRecord(value) ||
        !Object.entries(value).every(([k, v]) => ['maxTurns', 'maxTokens'].includes(k) && positiveInt(v))
      )
        return `${source}.budget must hold only positive maxTurns and maxTokens`;
    } else if (key === 'permissions') {
      if (!isRecord(value)) return `${source}.permissions must be an object`;
      for (const [field, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        if (field === 'tools') {
          const problem = toolsWithin(entry, `${source}.permissions.tools`);
          if (problem) return problem;
        } else if (field === 'readOnly' && entry === true) {
          continue;
        } else if (
          field === 'agents' &&
          isRecord(entry) &&
          Object.entries(entry).every(([k, v]) => k === 'maxDepth' && typeof v === 'number')
        ) {
          continue;
        } else {
          return `${source}.permissions.${field} would not be enforced by ${role}`;
        }
      }
    } else {
      return `${source}.${key} is not used by role ${role}`;
    }
  }
  return pieces;
}

/** Append whole items the task does not already hold; return the task and the names of what was appended. */
function fold(task: string, pieces: Pieces, includeGoal: boolean): { task: string; appended: string[] } {
  const present = new Set(
    task
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean),
  );
  present.add(task.trim());
  const parts = [task];
  const appended: string[] = [];
  if (includeGoal && nonEmpty(pieces.goal) && !present.has(pieces.goal.trim())) {
    parts.push(`Goal: ${pieces.goal.trim()}`);
    appended.push('goal');
  }
  const constraints = [...new Set(pieces.constraints)].filter((line) => !present.has(line));
  if (constraints.length) {
    parts.push(`Constraints:\n${constraints.map((line) => `- ${line}`).join('\n')}`);
    appended.push('constraints');
  }
  if (nonEmpty(pieces.doneWhen) && !present.has(pieces.doneWhen.trim())) {
    parts.push(`Done when: ${pieces.doneWhen.trim()}`);
    appended.push('doneWhen');
  }
  if (pieces.context && Object.keys(pieces.context).length > 0) {
    parts.push(`Context: ${JSON.stringify(pieces.context)}`);
    appended.push('context');
  }
  return { task: parts.join('\n\n'), appended };
}

function describe(role: string, unused: string, appended: string[], ignored: string[]): string {
  return (
    `Read as role "${role}" with task; ${unused}` +
    (appended.length ? `; appended to the task: ${appended.join(', ')}` : '') +
    (ignored.length ? `; ignored (the role's own tools and limits apply): ${ignored.join(', ')}` : '') +
    '.'
  );
}

/** Rewrite a recoverable call to `role` + `task`, or report why it cannot be. Other input passes unchanged. */
function normalizeRunSubagentShape(raw: unknown): Shape {
  if (!isRecord(raw) || !nonEmpty(raw.role)) return { ok: true, value: raw };
  const role = raw.role;
  const task = nonEmpty(raw.task) ? raw.task : undefined;
  const stray = (['doneWhen', 'constraints', 'tools'] as const).filter((field) => raw[field] !== undefined);
  const spec = raw.agent_spec;
  if (spec === undefined && (!stray.length || !task)) return { ok: true, value: raw };
  // Writing roles (and roles with no recorded mixed call) are never rewritten: a dropped scope could widen them.
  if (!Object.hasOwn(READ_ONLY_ROLE_TOOLS, role))
    return reject(`role ${role} is not combined with ${spec !== undefined ? 'agent_spec' : stray.join(', ')}`);

  if (spec !== undefined) {
    if (!isRecord(spec)) return { ok: true, value: raw };
    const read = readSpec(role, spec, 'agent_spec');
    if (typeof read === 'string') return reject(read);
    const base = task ?? (nonEmpty(read.goal) ? read.goal : undefined);
    if (!base) return { ok: true, value: raw };
    const { agent_spec: _dropped, ...rest } = raw;
    const folded = fold(base, read, task !== undefined);
    const ignored = ['tools', 'permissions', 'budget'].filter((field) => spec[field] !== undefined);
    return {
      ok: true,
      value: { ...rest, task: folded.task },
      interpretation: describe(
        role,
        'agent_spec was not launched',
        [...(task ? [] : ['goal (as the task)']), ...folded.appended],
        ignored,
      ),
    };
  }

  const read = readSpec(role, Object.fromEntries(stray.map((field) => [field, raw[field]])), 'top-level');
  if (typeof read === 'string') return reject(read);
  const { doneWhen: _d, constraints: _c, tools: _t, ...rest } = raw;
  const folded = fold(task!, read, false);
  return {
    ok: true,
    value: { ...rest, task: folded.task },
    interpretation: describe(
      role,
      `top-level ${stray.join(', ')} not taken as fields`,
      folded.appended,
      stray.includes('tools') ? ['tools'] : [],
    ),
  };
}

/**
 * Wrap the canonical schema so validation sees the rewritten call. The wrapper is a plain preprocess, so it
 * renders as the canonical schema's JSON form. The interpretation line is kept by identity of the parsed
 * value, which is the object the executor receives on the native path; a direct caller re-derives it.
 */
export function withRunSubagentShapes(canonical: ZodTypeAny): {
  readonly schema: ZodTypeAny;
  readonly resolve: (params: unknown) => { readonly params: unknown; readonly interpretation?: string };
} {
  const interpretations = new WeakMap<object, string>();
  const shape = (raw: unknown): Shape => normalizeRunSubagentShape(normalizeObjectParams(raw, canonical));
  // Set by the preprocess and read by the refinement of the same synchronous parse.
  let pending: string | undefined;
  const schema = z.preprocess(
    (raw, ctx) => {
      pending = isRecord(raw) ? interpretations.get(raw) : undefined;
      const shaped = shape(raw);
      if (!shaped.ok) {
        ctx.addIssue({ code: 'custom', message: shaped.message });
        return raw;
      }
      pending = shaped.interpretation ?? pending;
      return shaped.value;
    },
    canonical.superRefine((value) => {
      if (pending && isRecord(value)) interpretations.set(value, pending);
      pending = undefined;
    }),
  );
  return {
    schema,
    resolve(params) {
      const known = isRecord(params) ? interpretations.get(params) : undefined;
      if (known) return { params, interpretation: known };
      const shaped = shape(params);
      return shaped.ok ? { params: shaped.value, interpretation: shaped.interpretation } : { params };
    },
  };
}

/** One line telling the model how a mixed-shape call was read; JSON results carry it as a field. */
export function withInterpretation(output: string, interpretation: string): string {
  const parsed = safeJsonParse(output);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    return JSON.stringify({ ...(parsed as Record<string, unknown>), interpretation });
  return `${output}\n\nInterpretation: ${interpretation}`;
}
