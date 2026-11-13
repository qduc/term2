/**
 * Recoverable `run_subagent` argument shapes.
 *
 * Real runs showed a model's first call mixing the two documented shapes: a
 * named `role` (with or without `task`) plus an `agent_spec`, or agent_spec
 * fields (`doneWhen`, `tools`) at the top level. The schema rejected those and
 * every retry asked again for the named role with a task, costing one provider
 * request each time. This module rewrites such a call to the one shape the
 * retries chose, or names the single shape to send when the two disagree on
 * authority. The canonical schema still validates the rewritten call.
 *
 * Authority: the rewritten call is always plain `role` + `task`, so it grants
 * exactly what that role alone grants. Nothing from the dropped agent_spec is
 * merged into the run except text. A spec that asks for a capability the role
 * lacks, or for a model, is a genuine conflict and is rejected.
 */
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { normalizeObjectParams } from '../tool-invoke.js';

/**
 * Tools each named role is offered, in agent_spec's tool vocabulary (from the
 * `can*` frontmatter of `session/prompts/subagents/<role>.md`). Used only to
 * decide that a spec asks for something the role does not provide; the
 * rewritten call is a plain role launch, so this table never grants anything.
 */
const ROLE_TOOLS: Readonly<Record<string, readonly string[]>> = {
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
  worker: [
    'read_file',
    'grep',
    'glob',
    'read_code_outline',
    'code_context_search',
    'shell',
    'apply_patch',
    'search_replace',
    'create_file',
  ],
  librarian: [],
  mentor: [],
  reviewer: [],
};

/** agent_spec fields that are only text for the child, folded into the task. */
const SPEC_TEXT_FIELDS = ['goal', 'constraints', 'doneWhen', 'context'] as const;
/** agent_spec fields seen misplaced at the top level of a role call. */
const STRAY_TOP_LEVEL_FIELDS = ['doneWhen', 'constraints', 'tools'] as const;

type RunSubagentShape =
  | { readonly ok: true; readonly value: unknown; readonly interpretation?: string }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

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

function constraintLines(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim())
    : [];
}

/** Text the child would have read from the dropped fields, minus what the task already says. */
function foldedTask(base: string, source: Record<string, unknown>): string {
  const has = (text: string) => base.includes(text.trim());
  const parts = [base];
  const constraints = constraintLines(source.constraints).filter((line) => !has(line));
  if (constraints.length) parts.push(`Constraints:\n${constraints.map((line) => `- ${line}`).join('\n')}`);
  if (typeof source.doneWhen === 'string' && source.doneWhen.trim() && !has(source.doneWhen))
    parts.push(`Done when: ${source.doneWhen.trim()}`);
  if (isRecord(source.context) && Object.keys(source.context).length > 0)
    parts.push(`Context: ${JSON.stringify(source.context)}`);
  return parts.join('\n\n');
}

// The diagnostic keeps about 160 characters of this message, so the instruction comes first.
function conflict(reason: string): RunSubagentShape {
  return { ok: false, message: `Send role+task without agent_spec, or agent_spec alone (${reason})` };
}

const WRITE_TOOLS = ['apply_patch', 'search_replace', 'create_file'];

/** The spec's authority claims that disagree with what the named role grants on its own. */
function specConflict(role: string, spec: Record<string, unknown>, source = 'agent_spec'): string | undefined {
  const allowed = ROLE_TOOLS[role];
  if (!allowed) return `role "${role}" has no known tool set`;
  if (spec.model !== undefined) return `${source}.model is not used by role ${role}`;
  const permissions = isRecord(spec.permissions) ? spec.permissions : {};
  const listed = [toolList(spec.tools), toolList(permissions.tools)].filter((list) => list !== undefined);
  const requested = listed.flat();
  const missing = [...new Set(requested.filter((tool) => !allowed.includes(tool)))];
  if (missing.length) return `${source} asks for ${missing.join(', ')}, which ${role} lacks`;
  const filesystem = isRecord(permissions.filesystem) ? permissions.filesystem : {};
  const writes = Array.isArray(filesystem.write) && filesystem.write.length > 0;
  if (writes && !allowed.some((tool) => WRITE_TOOLS.includes(tool))) return `${role} cannot write files`;
  // A spec without writes (no tools means read-only defaults) must not become a writing role.
  const withholdsWrites =
    (Array.isArray(filesystem.write) && filesystem.write.length === 0) ||
    !listed.some((list) => list.some((tool) => WRITE_TOOLS.includes(tool)));
  if (withholdsWrites && allowed.some((tool) => WRITE_TOOLS.includes(tool)))
    return `${source} is read-only but ${role} writes files`;
  if (isRecord(permissions.agents) && permissions.agents.create === true) return `${role} cannot create agents`;
  return undefined;
}

/**
 * Rewrite a recoverable call to `role` + `task`, or report a conflict. Any other
 * input, valid or not, is returned unchanged for the canonical schema to judge.
 */
function normalizeRunSubagentShape(raw: unknown): RunSubagentShape {
  if (!isRecord(raw) || typeof raw.role !== 'string' || !raw.role) return { ok: true, value: raw };
  const role = raw.role;
  const task = typeof raw.task === 'string' && raw.task.trim() ? raw.task : undefined;
  const spec = isRecord(raw.agent_spec) ? raw.agent_spec : undefined;
  const stray = STRAY_TOP_LEVEL_FIELDS.filter((field) => raw[field] !== undefined);

  if (spec) {
    const reason = specConflict(role, spec);
    if (reason) return conflict(reason);
    const goal = typeof spec.goal === 'string' && spec.goal.trim() ? spec.goal : undefined;
    const base = task ?? goal;
    if (!base) return { ok: true, value: raw };
    const { agent_spec: _dropped, ...rest } = raw;
    // When the model also wrote a task, the spec's goal restated it in every recorded call; keep the task.
    const value = { ...rest, task: foldedTask(base, spec) };
    const ignored = ['tools', 'permissions', 'budget'].filter((field) => spec[field] !== undefined);
    const folded = SPEC_TEXT_FIELDS.filter((field) => spec[field] !== undefined && (field !== 'goal' || !task));
    return {
      ok: true,
      value,
      interpretation:
        `Ran as role "${role}" with task; agent_spec was not used` +
        (folded.length ? ` (its ${folded.join(', ')} added to the task)` : '') +
        (ignored.length ? `; its ${ignored.join(', ')} not applied, the role's own tools and limits apply` : '') +
        '.',
    };
  }

  if (!stray.length || !task) return { ok: true, value: raw };
  if (raw.tools !== undefined) {
    const tools = toolList(raw.tools);
    if (!tools) return { ok: true, value: raw };
    const reason = specConflict(role, { tools }, 'top-level tools');
    if (reason) return conflict(reason);
  }
  const { doneWhen: _d, constraints: _c, tools: _t, ...rest } = raw;
  const folded = stray.filter((field) => field !== 'tools');
  return {
    ok: true,
    value: { ...rest, task: foldedTask(task, raw) },
    interpretation:
      `Ran as role "${role}" with task` +
      (folded.length ? `; top-level ${folded.join(', ')} added to the task` : '') +
      (stray.includes('tools') ? "; top-level tools not applied, the role's own tools apply" : '') +
      '.',
  };
}

/**
 * Wrap the canonical schema so validation sees the rewritten call. The parsed
 * value is the rewritten call; its interpretation line is kept by identity for
 * the executor, which receives that exact object from either invocation path.
 */
export function withRunSubagentShapes(canonical: ZodTypeAny): {
  readonly schema: ZodTypeAny;
  readonly resolve: (params: unknown) => { readonly params: unknown; readonly interpretation?: string };
} {
  const interpretations = new WeakMap<object, string>();
  const shape = (raw: unknown): RunSubagentShape => normalizeRunSubagentShape(normalizeObjectParams(raw, canonical));
  const schema = z.unknown().transform((raw, ctx) => {
    const shaped = shape(raw);
    if (!shaped.ok) {
      ctx.addIssue({ code: 'custom', message: shaped.message });
      return z.NEVER;
    }
    const parsed = canonical.safeParse(shaped.value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom', message: issue.message });
      return z.NEVER;
    }
    const value: unknown = parsed.data;
    const inherited = isRecord(raw) ? interpretations.get(raw) : undefined;
    const interpretation = shaped.interpretation ?? inherited;
    if (interpretation && isRecord(value)) interpretations.set(value, interpretation);
    return value;
  });
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
