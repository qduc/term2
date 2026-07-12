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
import type { SubagentResult } from '../../services/subagents/types.js';
import { isAbortLike } from '../../services/subagents/utils.js';

const RUN_SUBAGENT_DESCRIPTION =
  'Delegate a bounded task to a specialized subagent. The subagent runs synchronously and returns a structured result. ' +
  'The subagent runs in its own context and returns only a summary, preserving your context. ' +
  '(When to reach for this vs. doing it yourself is covered by the delegation guidance in your system instructions.)\n\n' +
  '## Task Requirements\n' +
  'Include the objective, task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable. ' +
  'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog. ' +
  'The subagent does not see your conversation or reasoning.\n\n' +
  'Returns a summary with status (completed, failed, or cancelled), any final text, a list of tools used, and files changed.';

const runSubagentSchema = z.object({
  role: z
    .enum(['explorer', 'worker', 'researcher', 'mentor'])
    .describe('The subagent role to use: "explorer", "worker", "researcher", or "mentor".'),
  task: z.string().describe('The full task description.'),
});

export type RunSubagentParams = z.infer<typeof runSubagentSchema>;

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

function formatSubagentResult(result: SubagentResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.finalText) {
    lines.push('');
    lines.push(result.finalText);
  }

  if (result.toolsUsed && result.toolsUsed.length > 0) {
    lines.push('');
    lines.push(`Tools used: ${result.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`);
  }

  if (result.filesChanged && result.filesChanged.length > 0) {
    lines.push('');
    lines.push(`Files changed: ${result.filesChanged.join(', ')}`);
  }

  return lines.join('\n') || `Status: ${result.status}`;
}

export const formatRunSubagentCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const role = args?.role ?? 'subagent';
  const rawOutput = getOutputText(item);
  const parsed = safeJsonParse(rawOutput) as SubagentResult | null;

  const taskPreview = truncatePreview(args?.task);
  let command = taskPreview ? `run_subagent [${role}] ${taskPreview}` : `run_subagent [${role}]`;
  let output = rawOutput || 'No response';
  let success = true;

  if (parsed) {
    success = parsed.status === 'completed';
    const toolsSummary =
      parsed.toolsUsed?.length > 0
        ? `Tools: ${parsed.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`
        : '';
    const filesSummary = parsed.filesChanged?.length > 0 ? `Files changed: ${parsed.filesChanged.join(', ')}` : '';

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

export function getSubagentsRolesSection(): string {
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
      '- `explorer`: read-only workspace access. Use for locating files and answering codebase questions.\n' +
      '- `researcher`: web search + read-only workspace. Use for looking up external docs or current information.\n' +
      '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' +
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
    '- `explorer`: read-only workspace access. Use for locating files and answering codebase questions.\n' +
    '- `researcher`: web search + read-only workspace. Use for looking up external docs or current information.\n' +
    '- `mentor`: advisory only, no workspace access. Use for technical advice.\n' +
    '- `worker`: read + write access. Use for implementing bounded file changes.\n\n'
  );
}

export const createRunSubagentToolDefinition = (
  runSubagent: (params: RunSubagentParams, context?: unknown, details?: unknown) => Promise<SubagentResult>,
): ToolDefinition<RunSubagentParams> => ({
  name: 'run_subagent',
  description: RUN_SUBAGENT_DESCRIPTION,
  parameters: runSubagentSchema,
  needsApproval: () => false,
  execute: async (params, context, details) => {
    try {
      const result = await runSubagent(params, context, details);
      return formatSubagentResult(result);
    } catch (error: any) {
      if (isAbortLike(error?.message, error)) {
        throw error;
      }
      const errorResult: SubagentResult = {
        agentId: 'error',
        role: params.role,
        status: 'failed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
        error: error?.message || String(error),
      };
      return formatSubagentResult(errorResult);
    }
  },
  formatCommandMessage: formatRunSubagentCommandMessage,
});
