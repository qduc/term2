import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';
import type { NestedSubagentResult, SubagentResult, SubagentRunHandle } from '../../services/subagents/types.js';
import { SUBAGENT_RUN_NAME_PATTERN, SubagentRegistryError } from '../../services/subagents/subagent-async-registry.js';
import { isAbortLike, formatSubagentResult } from '../../services/subagents/utils.js';

const RUN_SUBAGENT_DESCRIPTION =
  'Delegate a bounded task to a specialized subagent. Set execution to "foreground" when you need the structured result in this turn, ' +
  'or "background" when the work can continue after you return control; background returns a running handle and later completion notification. ' +
  'The subagent runs in its own context and returns only a summary, preserving your context. ' +
  '(When to reach for this vs. doing it yourself is covered by the delegation guidance in your system instructions.)\n\n' +
  'Independent foreground explorer and librarian calls in the same model response may run in parallel; keep worker calls and dependent tasks serial.\n\n' +
  '## Task Requirements\n' +
  'Include the objective, task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable. ' +
  'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog. ' +
  'The subagent does not see your conversation or reasoning. ' +
  "For explorer, request concrete evidence to collect for a bounded question. Do not ask explorer to diagnose, recommend a fix, choose an approach, or own the user's complete investigation, review, diagnosis, or planning deliverable.\n\n" +
  'For isolated worker edits, create a git worktree under the workspace root first ' +
  '(`git worktree add .worktrees/<slug> -b <slug>`), then pass `worktree` as that directory basename or branch name. ' +
  '`worktree` is worker-only; it pins the child into that existing tree without re-rooting this session.\n\n' +
  'Foreground returns a summary with status (completed, failed, cancelled, or interrupted), any final text, a list of tools used, and files changed. ' +
  'A background status of "running" means launch succeeded: do not duplicate the task or immediately call get_subagent_result; end the turn and wait for the completion notification.';

const FOREGROUND_ROLES = ['explorer', 'worker', 'librarian'] as const;
const BACKGROUND_ROLES = ['explorer', 'worker', 'mentor', 'librarian'] as const;
const ALL_ROLES = ['explorer', 'worker', 'mentor', 'librarian'] as const;
const SUBAGENT_TASK_DESCRIPTION =
  'Complete description of one bounded delegated unit. For explorer, specify concrete evidence to collect, not diagnosis, recommendations, or the parent task itself.';

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
    .describe('Continue a completed background run using its runId. Background only; worker continuation is blocked.'),
};

const worktreeField = {
  worktree: z
    .string()
    .optional()
    .describe(
      'Worker only. Directory basename or branch of an existing git worktree to pin the child into. ' +
        'Create the worktree first under the workspace root; this does not re-root the parent session.',
    ),
};

const runSubagentSchema = z
  .object({
    execution: z
      .enum(['foreground', 'background'])
      .describe('"foreground" returns the result in this turn; "background" returns a running handle immediately.'),
    role: z.enum(ALL_ROLES).describe('The subagent role to use.'),
    task: z.string().describe(SUBAGENT_TASK_DESCRIPTION),
    ...worktreeField,
    ...backgroundFields,
  })
  .strict();

export type ForegroundRunSubagentParams = {
  role: (typeof FOREGROUND_ROLES)[number];
  task: string;
  worktree?: string;
};
export type RunSubagentParams =
  | ({ execution: 'foreground' } & ForegroundRunSubagentParams & {
        name?: string;
        continue_run_id?: string;
      })
  | {
      execution: 'background';
      role: (typeof BACKGROUND_ROLES)[number];
      task: string;
      name?: string;
      continue_run_id?: string;
      worktree?: string;
    };

export type RunSubagentToolCallbacks = {
  runSubagent?: (
    params: ForegroundRunSubagentParams,
    context?: unknown,
    details?: unknown,
  ) => Promise<NestedSubagentResult>;
  runSubagentAsync?: (
    params: Pick<
      Extract<RunSubagentParams, { execution: 'background' }>,
      'role' | 'task' | 'name' | 'continue_run_id' | 'worktree'
    >,
    context?: unknown,
    details?: unknown,
  ) => Promise<SubagentRunHandle>;
};

function createRunSubagentSchema({ runSubagent, runSubagentAsync }: RunSubagentToolCallbacks) {
  if (runSubagent && !runSubagentAsync) {
    return z
      .object({
        execution: z.literal('foreground').describe('Only foreground execution is available in this session.'),
        role: z.enum(FOREGROUND_ROLES).describe('The subagent role to use.'),
        task: z.string().describe(SUBAGENT_TASK_DESCRIPTION),
        ...worktreeField,
      })
      .strict();
  }

  if (!runSubagent && runSubagentAsync) {
    return z
      .object({
        execution: z.literal('background').describe('Only background execution is available in this session.'),
        role: z.enum(BACKGROUND_ROLES).describe('The subagent role to use.'),
        task: z.string().describe(SUBAGENT_TASK_DESCRIPTION),
        ...worktreeField,
        ...backgroundFields,
      })
      .strict();
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

export function getSubagentsRolesSection({
  includeLibrarian = true,
  includeMentor = true,
}: { includeLibrarian?: boolean; includeMentor?: boolean } = {}): string {
  let promptsDir = path.join(import.meta.dirname, '../prompts/subagents');
  if (!fs.existsSync(promptsDir)) {
    const altDir = path.join(import.meta.dirname, '../../source/prompts/subagents');
    if (fs.existsSync(altDir)) {
      promptsDir = altDir;
    }
  }

  if (!fs.existsSync(promptsDir)) {
    return (
      '## Roles\n' +
      '- `explorer`: read-only evidence collection + web search + safe shell commands. Use for locating facts, files, symbols, logs, tests, and external sources for a bounded parent question.\n' +
      (includeMentor ? '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' : '') +
      (includeLibrarian
        ? '- `librarian`: memory reasoning. Use for retrieving context from persistent memory and recommending memory maintenance.\n'
        : '') +
      '- `worker`: read + write + shell access. Use for implementing bounded file changes or general purpose works that does not fit any role above.\n\n'
    );
  }

  try {
    const files = fs
      .readdirSync(promptsDir)
      .filter((file) => file.endsWith('.md'))
      .sort();
    const roles: string[] = [];

    for (const file of files) {
      const roleName = path.basename(file, '.md');
      if ((roleName === 'librarian' && !includeLibrarian) || (roleName === 'mentor' && !includeMentor)) continue;
      const content = fs.readFileSync(path.join(promptsDir, file), 'utf-8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      let description = '';
      if (match) {
        const frontmatterText = match[1];
        for (const line of frontmatterText.split('\n')) {
          const colonIdx = line.indexOf(':');
          if (colonIdx !== -1) {
            const key = line.slice(0, colonIdx).trim();
            if (key === 'description') {
              let val = line.slice(colonIdx + 1).trim();
              if (
                val.length >= 2 &&
                ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
              ) {
                val = val.slice(1, -1);
              }
              description = val;
              break;
            }
          }
        }
      }
      if (description) {
        roles.push(`- \`${roleName}\`: ${description}`);
      }
    }

    if (roles.length > 0) {
      return '## Roles\n' + roles.join('\n') + '\n\n';
    }
  } catch (_error) {
    // Fallback on error
  }

  return (
    '## Roles\n' +
    '- `explorer`: read-only evidence collection + web search + safe shell commands. Use for locating facts, files, symbols, logs, tests, and external sources for a bounded parent question.\n' +
    (includeMentor ? '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' : '') +
    (includeLibrarian
      ? '- `librarian`: memory reasoning. Use for retrieving context from persistent memory and recommending memory maintenance.\n'
      : '') +
    '- `worker`: read + write access. Use for implementing bounded file changes.\n\n'
  );
}

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
): ToolDefinition {
  // Keep the factory's direct-test call shape temporarily compatible. The
  // model-facing schema always requires execution; only legacy direct callers
  // bypass schema normalization and take this foreground fallback.
  const legacyForegroundOnly = typeof callbacks === 'function';
  const resolvedCallbacks: RunSubagentToolCallbacks = legacyForegroundOnly ? { runSubagent: callbacks } : callbacks;
  const parameters = createRunSubagentSchema(resolvedCallbacks);

  return {
    name: 'run_subagent',
    description: RUN_SUBAGENT_DESCRIPTION,
    parameters,
    parallelSafe: (params: unknown) => {
      const candidate = params as Partial<RunSubagentParams>;
      return candidate.execution === 'foreground' && (candidate.role === 'explorer' || candidate.role === 'librarian');
    },
    needsApproval: () => false,
    execute: async (rawParams: unknown, context, details) => {
      const params = rawParams as RunSubagentParams;
      if (params.execution === 'foreground' || (legacyForegroundOnly && params.execution === undefined)) {
        if (params.name != null || params.continue_run_id != null) {
          return failedForegroundResult(
            params.role,
            'Background-only inputs name and continue_run_id cannot be used with execution: "foreground".',
          );
        }
        if (!resolvedCallbacks.runSubagent) {
          return failedForegroundResult(params.role, 'Foreground execution is unavailable in this session.');
        }
        if (!FOREGROUND_ROLES.includes(params.role as (typeof FOREGROUND_ROLES)[number])) {
          return failedForegroundResult(params.role, `Role "${params.role}" is unavailable for foreground execution.`);
        }
        try {
          const result = await resolvedCallbacks.runSubagent(
            {
              role: params.role as (typeof FOREGROUND_ROLES)[number],
              task: params.task,
              ...(params.worktree ? { worktree: params.worktree } : {}),
            },
            context,
            details,
          );
          return formatSubagentResult(result as SubagentResult);
        } catch (error: unknown) {
          if (isAbortLike(error instanceof Error ? error.message : undefined, error)) {
            throw error;
          }
          return failedForegroundResult(params.role, error);
        }
      }

      if (!resolvedCallbacks.runSubagentAsync) {
        return JSON.stringify({
          status: 'failed',
          error: { code: 'background_unavailable', message: 'Background execution is unavailable in this session.' },
        });
      }
      try {
        return formatBackgroundHandle(
          await resolvedCallbacks.runSubagentAsync(
            {
              role: params.role,
              task: params.task,
              name: params.name ?? undefined,
              continue_run_id: params.continue_run_id ?? undefined,
              ...(params.worktree ? { worktree: params.worktree } : {}),
            },
            context,
            details,
          ),
        );
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
    },
    formatCommandMessage: formatRunSubagentCommandMessage,
  };
}
