import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition, FormatCommandMessage } from './types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from './format-helpers.js';
import type { SubagentResult } from '../services/subagents/types.js';

const runSubagentSchema = z.object({
  role: z.string().describe('The subagent role to use: "explorer", "worker", "researcher", or "mentor".'),
  task: z
    .string()
    .describe(
      'The full task description. Include all relevant context, constraints, and the expected output format. ' +
        'The subagent has no access to your conversation history or reasoning.',
    ),
  writeBoundary: z
    .array(z.string())
    .optional()
    .describe(
      'For worker role: restrict writes to these relative paths within the workspace. ' +
        'Defaults to the workspace root when omitted.',
    ),
});

export type RunSubagentParams = z.infer<typeof runSubagentSchema>;

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

  let command = `run_subagent [${role}]`;
  let output = rawOutput || 'No response';
  let success = true;

  if (parsed) {
    success = parsed.status === 'completed';
    const toolsSummary =
      parsed.toolsUsed?.length > 0
        ? `Tools: ${parsed.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`
        : '';
    const filesSummary = parsed.filesChanged?.length > 0 ? `Files changed: ${parsed.filesChanged.join(', ')}` : '';

    const parts = [parsed.finalText || parsed.error || 'No output'];
    if (toolsSummary) parts.push(toolsSummary);
    if (filesSummary) parts.push(filesSummary);
    output = parts.filter(Boolean).join('\n');

    if (parsed.error) {
      command = `run_subagent [${role}] — failed`;
    }
  } else if (rawOutput?.includes('Status: failed')) {
    success = false;
    command = `run_subagent [${role}] — failed`;
  } else if (rawOutput?.includes('Status: cancelled')) {
    success = false;
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
      '- `worker`: read + write access. Use for implementing bounded file changes.\n\n'
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
  } catch (error) {
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
  runSubagent: (params: RunSubagentParams) => Promise<SubagentResult>,
): ToolDefinition<RunSubagentParams> => ({
  name: 'run_subagent',
  description:
    'Delegate a bounded task to a specialized subagent. The subagent runs synchronously and returns a structured result.\n\n' +
    '## When to Use\n' +
    'Prefer a subagent when you care about the **result** but not the **intermediate steps**. ' +
    'Good fits: long exploration across many files, multi-step research, or implementation work that ' +
    'would otherwise fill your context with tool calls, file contents, and dead ends. ' +
    'The subagent absorbs that noise and returns only a summary, preserving your context for ' +
    'higher-level reasoning and decisions.\n\n' +
    'Avoid delegating: trivial single-file reads, tasks requiring back-and-forth with the user, ' +
    'or work where you need to observe progress to course-correct.\n\n' +
    getSubagentsRolesSection() +
    '## Task Requirements\n' +
    'The task must be fully self-contained. Include all context, constraints, and the expected output format. ' +
    'The subagent has no access to your conversation history or reasoning.\n\n' +
    '## Write Boundary (worker only)\n' +
    'Use `writeBoundary` to restrict which paths the worker may modify. Omit to allow writes anywhere in the workspace.',
  parameters: runSubagentSchema,
  needsApproval: () => false,
  execute: async (params) => {
    try {
      const result = await runSubagent(params);
      return formatSubagentResult(result);
    } catch (error: any) {
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
