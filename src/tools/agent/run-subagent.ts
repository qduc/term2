import { z } from 'zod';
import type { DirectToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';
import type { NestedSubagentResult, SubagentResult, SubagentRunHandle } from '../subagents/types.js';
import { SUBAGENT_RUN_NAME_PATTERN, SubagentRegistryError } from '../subagents/launch-contract.js';
import { isAbortLike, formatSubagentResult } from '../subagents/utils.js';
import { relaxedNumber } from '../utils.js';
import { AGENT_SPEC_TOOL_NAMES } from './agent-spec-tools.js';
import { withRunSubagentShapes } from './run-subagent-shape.js';

function getRunSubagentDescription(backgroundEnabled: boolean): string {
  return (
    'Delegate a bounded task to the general agent runtime. Use agent_spec for dynamic goal/context/tools/constraints/model/budget; legacy named roles are compatibility presets. ' +
    (backgroundEnabled
      ? 'execution "foreground" (explorer and librarian only) waits for the child and returns its result in this call: use it when you need the result before your next step. "background" returns a running handle immediately and a later completion notification: use it for long or parallel independent work. '
      : 'This session uses foreground execution and returns the structured result in this turn. ') +
    'The subagent runs in its own context and returns only a summary, preserving your context. ' +
    '(When to reach for this vs. doing it yourself is covered by the delegation guidance in your system instructions.)\n\n' +
    (backgroundEnabled
      ? 'Background launches return immediately; do not duplicate them or call get_subagent_result until the completion notification arrives.\n\n'
      : 'Independent foreground explorer and librarian calls in the same model response may run in parallel; keep worker calls and dependent tasks serial.\n\n') +
    '## Task Requirements\n' +
    'Give the task one clear objective, one ownership boundary, and one concrete done condition. Include the task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable. ' +
    'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog. ' +
    'The subagent does not see your conversation or reasoning. ' +
    "For explorer, request concrete evidence to collect for a bounded question and choose breadth or depth, never both: map one defined surface shallowly or trace one narrow seam thoroughly. Do not ask explorer to diagnose, recommend a fix, choose an approach, or own the user's complete investigation, review, diagnosis, or planning deliverable. " +
    'For worker, assign one cohesive implementation unit. For mentor, ask one decision or challenge question. ' +
    'For reviewer, describe the artifact to review (diff range, files, plan) and the review criteria; it gathers evidence only through explorers. ' +
    'For librarian, assign one history question to answer from memory and prior sessions, or one memory-maintenance topic boundary.\n\n' +
    'For isolated worker edits, create a git worktree under the workspace root first ' +
    '(`git worktree add .worktrees/<slug> -b <slug>`), then pass `worktree` as that directory basename or branch name. ' +
    '`worktree` pins the child into that existing tree without re-rooting this session; generic writable agents may use it too.\n\n' +
    (backgroundEnabled
      ? 'A background status of "running" means launch succeeded: end the turn and wait for the completion notification.'
      : 'Foreground returns a summary with status (completed, failed, cancelled, or interrupted), any final text, a list of tools used, and files changed.')
  );
}

const FOREGROUND_ROLES = ['explorer', 'worker', 'reviewer', 'librarian'] as const;
/** Foreground roles offered beside background: they write no files, so a wait never holds an edit. */
const WAITABLE_ROLES = ['explorer', 'librarian'] as const;
const BACKGROUND_ROLES = ['explorer', 'worker', 'mentor', 'reviewer', 'librarian'] as const;
const ALL_ROLES = ['explorer', 'worker', 'mentor', 'reviewer', 'librarian'] as const;
// The explorer sentence stays: the description's Task Requirements state narrower deliverables, not
// "recommendations" or "the parent task itself".
const SUBAGENT_TASK_DESCRIPTION =
  'Complete description of one bounded delegated unit with one objective, ownership boundary, and done condition. For explorer, specify concrete evidence to collect and choose breadth or depth, never both; do not delegate diagnosis, recommendations, or the parent task itself.';

export const agentSpecSchema = z
  .object({
    goal: z.string().describe('The goal for this general-purpose agent invocation.'),
    context: z.record(z.string(), z.unknown()).optional(),
    tools: z
      .array(z.enum(AGENT_SPEC_TOOL_NAMES))
      .readonly()
      .optional()
      .describe('Optional allowlist of child-buildable tools; omitted defaults to read-only workspace tools.'),
    permissions: z
      .object({
        tools: z.array(z.enum(AGENT_SPEC_TOOL_NAMES)).readonly().optional(),
        filesystem: z
          .object({ read: z.array(z.string()).optional(), write: z.array(z.string()).optional() })
          .optional(),
        network: z.object({ hosts: z.array(z.string()).optional() }).optional(),
        agents: z.object({ create: z.boolean().optional(), maxDepth: z.number().optional() }).optional(),
      })
      .optional(),
    constraints: z.array(z.string()).optional(),
    doneWhen: z.string().optional(),
    model: z
      .union([z.enum(['efficient', 'balanced', 'capable']), z.object({ provider: z.string(), model: z.string() })])
      .optional(),
    budget: z
      .object({
        maxTurns: z.number().int().positive().optional().describe('Maximum model turns; defaults to 200.'),
        maxTokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Provider output-token cap per model response, not an aggregate run token budget.'),
      })
      .strict()
      .optional()
      .describe('Only enforced per-invocation budgets are accepted.'),
  })
  .strict();

/** Input contract for the injected launcher; runtime resolution stays host-side. */
type AgentSpec = z.infer<typeof agentSpecSchema>;

const backgroundFields = {
  name: z
    .string()
    .regex(SUBAGENT_RUN_NAME_PATTERN)
    .optional()
    .describe(
      'Optional active-run alias: lowercase letter first, then up to 31 lowercase letters, digits, underscores, or hyphens. Background only.',
    ),
  continue_run_id: z
    .string()
    .optional()
    .describe(
      'Continue a completed background run using its runId. Background only; writable generic runs and workers cannot continue.',
    ),
  check_in: z
    .object({
      enabled: z
        .boolean()
        .optional()
        .describe('Enable or disable proactive check-ins for this background subagent. Defaults to true.'),
      interval_seconds: relaxedNumber
        .int()
        .positive()
        .optional()
        .describe('Custom interval in seconds between proactive check-ins.'),
    })
    .optional()
    .describe('Optional check-in configuration for this background subagent. Background only.'),
};

// Creating the worktree first, and not re-rooting this session, is stated once, in the tool description.
const worktreeField = {
  worktree: z
    .string()
    .optional()
    .describe(
      'For write-capable workers or generic agent specs. Directory basename or branch of an existing git worktree to pin the child into.',
    ),
};

const hasOneShape = (value: { agent_spec?: unknown; role?: unknown; task?: unknown }) =>
  value.agent_spec ? value.role === undefined && value.task === undefined : Boolean(value.role) && Boolean(value.task);
const ONE_SHAPE_MESSAGE = { message: 'Provide agent_spec, or both role and task.' };

const runSubagentSchema = z
  .object({
    execution: z
      .enum(['foreground', 'background'])
      .describe('"foreground" returns the result in this turn; "background" returns a running handle immediately.'),
    role: z.enum(ALL_ROLES).optional().describe('Optional legacy role preset. Omit when supplying agent_spec.'),
    task: z.string().optional().describe(SUBAGENT_TASK_DESCRIPTION),
    agent_spec: agentSpecSchema
      .optional()
      .describe('Dynamic goal/context/tools/constraints/model/budget; no named role required.'),
    ...worktreeField,
    ...backgroundFields,
  })
  .strict()
  .refine(hasOneShape, ONE_SHAPE_MESSAGE);

export type ForegroundRunSubagentParams = {
  role?: (typeof FOREGROUND_ROLES)[number] | 'agent';
  task?: string;
  agent_spec?: AgentSpec;
  worktree?: string;
};
export type RunSubagentParams =
  | ({ execution: 'foreground' } & ForegroundRunSubagentParams & {
        name?: string;
        continue_run_id?: string;
        check_in?: { enabled?: boolean; interval_seconds?: number };
      })
  | {
      execution: 'background';
      role?: (typeof BACKGROUND_ROLES)[number] | 'agent';
      task?: string;
      agent_spec?: AgentSpec;
      name?: string;
      continue_run_id?: string;
      worktree?: string;
      check_in?: { enabled?: boolean; interval_seconds?: number };
    };

export type RunSubagentToolCallbacks = {
  runSubagent?: (
    params: ForegroundRunSubagentParams,
    context?: unknown,
    details?: unknown,
  ) => Promise<NestedSubagentResult>;
  runSubagentAsync?: (
    params: {
      role?: (typeof BACKGROUND_ROLES)[number] | 'agent';
      task?: string;
      agent_spec?: AgentSpec;
      name?: string;
      continue_run_id?: string;
      worktree?: string;
    },
    context?: unknown,
    details?: unknown,
  ) => Promise<SubagentRunHandle>;
  configureCheckIn?: (
    target: { kind: 'shell' | 'subagent'; id: string },
    options: { enabled?: boolean; intervalMs?: number },
  ) => void;
};

function createRunSubagentSchema({ runSubagent, runSubagentAsync }: RunSubagentToolCallbacks) {
  if (runSubagentAsync) {
    return z
      .object({
        execution: z
          .enum(['foreground', 'background'])
          .describe(
            '"foreground" (explorer or librarian only) returns the result in this call; "background" returns a running handle immediately.',
          ),
        role: z.enum(BACKGROUND_ROLES).optional().describe('Optional legacy role preset.'),
        task: z.string().optional().describe(SUBAGENT_TASK_DESCRIPTION),
        agent_spec: runSubagentSchema.shape.agent_spec,
        ...worktreeField,
        ...backgroundFields,
      })
      .strict()
      .refine(hasOneShape, ONE_SHAPE_MESSAGE);
  }

  if (runSubagent && !runSubagentAsync) {
    return z
      .object({
        execution: z.literal('foreground').describe('Only foreground execution is available in this session.'),
        role: z.enum(FOREGROUND_ROLES).optional().describe('Optional legacy role preset.'),
        task: z.string().optional().describe(SUBAGENT_TASK_DESCRIPTION),
        agent_spec: runSubagentSchema.shape.agent_spec,
        ...worktreeField,
      })
      .strict()
      .refine(hasOneShape, ONE_SHAPE_MESSAGE);
  }

  return runSubagentSchema;
}

const MAX_PREVIEW_LENGTH = 300;

function truncatePreview(text: unknown): string {
  if (typeof text !== 'string') {
    return '';
  }

  const firstParagraph =
    text
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() || '';
  if (!firstParagraph) {
    return '';
  }

  if (firstParagraph.length <= MAX_PREVIEW_LENGTH) {
    return firstParagraph;
  }

  return `${firstParagraph.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

export const formatRunSubagentCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const role = args?.role ?? 'subagent';
  const rawOutput = getOutputText(item);
  const execution = args?.execution;
  const parsed = safeJsonParse(rawOutput) as {
    status?: SubagentResult['status'] | 'running';
    runId?: string;
    name?: string;
    finalText?: string;
    filesChanged?: SubagentResult['filesChanged'];
    toolsUsed?: SubagentResult['toolsUsed'];
    error?: string | { code?: string; message?: string };
  } | null;

  const taskPreview = truncatePreview(args?.task);
  let command = taskPreview
    ? `run_subagent [${execution === 'background' ? `background:${role}` : role}] ${taskPreview}`
    : `run_subagent [${execution === 'background' ? `background:${role}` : role}]`;
  let output = rawOutput || 'No response';
  let success = true;

  if (execution === 'background') {
    const launched = parsed?.status === 'running' && typeof parsed.runId === 'string';
    success = launched;
    if (launched) {
      command += ` — runId: ${parsed.runId}`;
      if (parsed.name) command += ` — name: ${parsed.name}`;
    } else {
      command += ' — failed';
      output =
        typeof parsed?.error === 'string'
          ? parsed.error
          : parsed?.error?.message ?? rawOutput ?? 'Background subagent launch failed';
    }
    return [
      createBaseMessage(item, index, 0, false, {
        command,
        output,
        success,
        toolName: 'run_subagent',
        toolArgs: args,
      }),
    ];
  }

  if (parsed) {
    success = parsed.status === 'completed';
    const toolsUsed = parsed.toolsUsed ?? [];
    const filesChanged = parsed.filesChanged ?? [];
    const toolsSummary =
      toolsUsed.length > 0 ? `Tools: ${toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}` : '';
    const filesSummary = filesChanged.length > 0 ? `Files changed: ${filesChanged.join(', ')}` : '';

    const outputPreview = truncatePreview(parsed.finalText || parsed.error || 'No output');
    const parts = [outputPreview];
    if (toolsSummary) parts.push(toolsSummary);
    if (filesSummary) parts.push(filesSummary);
    output = parts.filter(Boolean).join('\n');

    if (parsed.status === 'cancelled') {
      command = taskPreview
        ? `run_subagent [${role}] ${taskPreview} — cancelled`
        : `run_subagent [${role}] — cancelled`;
    } else if (parsed.error) {
      command = taskPreview ? `run_subagent [${role}] ${taskPreview} — failed` : `run_subagent [${role}] — failed`;
    }
  } else if (rawOutput?.includes('Status: failed')) {
    success = false;
    command = taskPreview ? `run_subagent [${role}] ${taskPreview} — failed` : `run_subagent [${role}] — failed`;
  } else if (rawOutput?.includes('Status: cancelled')) {
    success = false;
    command = taskPreview ? `run_subagent [${role}] ${taskPreview} — cancelled` : `run_subagent [${role}] — cancelled`;
  }

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'run_subagent',
      toolArgs: args,
    }),
  ];
};

function formatBackgroundHandle(handle: SubagentRunHandle): string {
  const output: Record<string, string> = { runId: handle.runId, status: handle.status };
  if (handle.name) output.name = handle.name;
  output.hint =
    'Background run launched — do NOT call get_subagent_result now. End your turn; the completion notification will inline the full result.';
  return JSON.stringify(output);
}

function failedForegroundResult(role: string, error: unknown): string {
  return formatSubagentResult({
    agentId: 'error',
    role,
    status: 'failed',
    finalText: '',
    filesChanged: [],
    toolsUsed: [],
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createRunSubagentToolDefinition(
  callbacks:
    | RunSubagentToolCallbacks
    | ((params: ForegroundRunSubagentParams, context?: unknown, details?: unknown) => Promise<NestedSubagentResult>),
): DirectToolDefinition<'run_subagent'> {
  // Keep the factory's direct-test call shape temporarily compatible. The
  // model-facing schema always requires execution; only legacy direct callers
  // bypass schema normalization and take this foreground fallback.
  const legacyForegroundOnly = typeof callbacks === 'function';
  const resolvedCallbacks: RunSubagentToolCallbacks = legacyForegroundOnly ? { runSubagent: callbacks } : callbacks;
  const parameters = createRunSubagentSchema(resolvedCallbacks);
  // The presented schema is unchanged; the canonical one first rewrites recoverable mixed shapes.
  const shapes = withRunSubagentShapes(parameters);

  return {
    name: 'run_subagent',
    description: getRunSubagentDescription(Boolean(resolvedCallbacks.runSubagentAsync)),
    parameters,
    canonicalParameters: shapes.schema,
    parallelSafe: (params: unknown) => {
      const candidate = shapes.resolve(params).params as Partial<RunSubagentParams>;
      return candidate.execution === 'foreground' && (candidate.role === 'explorer' || candidate.role === 'librarian');
    },
    needsApproval: () => false,
    execute: async (rawParams: unknown, context, details) => {
      const resolved = shapes.resolve(rawParams);
      const output = await executeRunSubagent(resolved.params as RunSubagentParams, context, details);
      return resolved.interpretation ? withInterpretation(output, resolved.interpretation) : output;
    },
    formatCommandMessage: formatRunSubagentCommandMessage,
  };

  async function executeRunSubagent(params: RunSubagentParams, context: unknown, details: unknown): Promise<string> {
    // Beside background, foreground is offered only to roles that cannot write files.
    if (
      resolvedCallbacks.runSubagentAsync &&
      params.execution === 'foreground' &&
      (params.agent_spec || !WAITABLE_ROLES.includes(params.role as (typeof WAITABLE_ROLES)[number]))
    ) {
      return JSON.stringify({
        status: 'failed',
        error: {
          code: 'foreground_unavailable',
          message: 'Foreground execution is available only for explorer and librarian; use execution: "background".',
        },
      });
    }
    if (params.execution === 'foreground' || (legacyForegroundOnly && params.execution === undefined)) {
      if (params.name != null || params.continue_run_id != null) {
        return failedForegroundResult(
          params.role ?? 'agent',
          'Background-only inputs name and continue_run_id cannot be used with execution: "foreground".',
        );
      }
      if (!resolvedCallbacks.runSubagent) {
        return failedForegroundResult(params.role ?? 'agent', 'Foreground execution is unavailable in this session.');
      }
      if (!params.agent_spec && !FOREGROUND_ROLES.includes(params.role as (typeof FOREGROUND_ROLES)[number])) {
        return failedForegroundResult(
          params.role ?? 'agent',
          `Role "${params.role}" is unavailable for foreground execution.`,
        );
      }
      try {
        const result = await resolvedCallbacks.runSubagent(
          {
            role: params.agent_spec ? 'agent' : (params.role as (typeof FOREGROUND_ROLES)[number]),
            task: params.agent_spec?.goal ?? params.task,
            ...(params.agent_spec ? { agent_spec: params.agent_spec } : {}),
            ...(params.worktree ? { worktree: params.worktree } : {}),
          },
          context,
          details,
        );
        // The user moved the live child to the background; its completion arrives as a notification.
        if (result.status === 'running')
          return formatBackgroundHandle({
            runId: result.agentId,
            role: result.role,
            status: 'running',
            task: params.task ?? '',
          });
        return formatSubagentResult(result as SubagentResult);
      } catch (error: unknown) {
        if (isAbortLike(error instanceof Error ? error.message : undefined, error)) {
          throw error;
        }
        return failedForegroundResult(params.role ?? 'agent', error);
      }
    }

    if (!resolvedCallbacks.runSubagentAsync) {
      return JSON.stringify({
        status: 'failed',
        error: { code: 'background_unavailable', message: 'Background execution is unavailable in this session.' },
      });
    }
    try {
      const handle = await resolvedCallbacks.runSubagentAsync(
        {
          role: params.agent_spec ? 'agent' : params.role,
          task: params.agent_spec?.goal ?? params.task,
          ...(params.agent_spec ? { agent_spec: params.agent_spec } : {}),
          name: params.name ?? undefined,
          continue_run_id: params.continue_run_id ?? undefined,
          ...(params.worktree ? { worktree: params.worktree } : {}),
        },
        context,
        details,
      );
      if (params.check_in !== undefined && resolvedCallbacks.configureCheckIn) {
        resolvedCallbacks.configureCheckIn(
          { kind: 'subagent', id: handle.runId },
          {
            enabled: params.check_in.enabled,
            intervalMs:
              params.check_in.interval_seconds !== undefined ? params.check_in.interval_seconds * 1000 : undefined,
          },
        );
      }
      return formatBackgroundHandle(handle);
    } catch (error: unknown) {
      if (isAbortLike(error instanceof Error ? error.message : undefined, error)) {
        throw error;
      }
      if (error instanceof SubagentRegistryError) {
        return JSON.stringify({ status: 'failed', error: { code: error.code, message: error.message } });
      }
      return JSON.stringify({
        status: 'failed',
        error: { code: 'execution_failed', message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/** One line telling the model how a mixed-shape call was read; JSON results carry it as a field. */
function withInterpretation(output: string, interpretation: string): string {
  const parsed = safeJsonParse(output);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    return JSON.stringify({ ...(parsed as Record<string, unknown>), interpretation });
  return `${output}\n\nInterpretation: ${interpretation}`;
}
