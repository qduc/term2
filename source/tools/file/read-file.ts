import { z } from 'zod';
import * as fs from 'fs/promises';
import { resolveWorkspacePath, relaxedNumber } from '../utils.js';
import { trimOutput } from '../../utils/output/output-trim.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';

const READ_FILE_DESCRIPTION =
  'Read file content from the workspace (like cat command). Supports reading specific line ranges. ' +
  'Use this to inspect a known file or verify a specific claim about a location. ' +
  'Avoid reading tiny repeated chunks (e.g. 50 lines at a time); read the full file if it is under 1000 lines or use a larger window. ' +
  'Do NOT use this to search for text across files (use grep) or to explore unfamiliar code (use run_subagent with an explorer). ' +
  'Returns the file path, total line count, and the requested lines.';
const READ_FILE_DESCRIPTION_OUTSIDE =
  'Read file content from the filesystem (like cat command). Supports reading specific line ranges. ' +
  'Use this to inspect a known file or verify a specific claim about a location. ' +
  'Avoid reading tiny repeated chunks (e.g. 50 lines at a time); read the full file if it is under 1000 lines or use a larger window. ' +
  'Returns the file path, total line count, and the requested lines.';
const READ_FILE_DESCRIPTION_ORCHESTRATOR =
  "Read file content to verify a specific claim about a known location (e.g., confirm a subagent's edit landed, check a referenced symbol). " +
  'For exploring unfamiliar code or understanding files you have not seen, prefer delegating to an `explorer` subagent via `run_subagent`. ' +
  'Supports line ranges — read the smallest relevant range. ' +
  'Returns the file path, total line count, and the requested lines.';

const readFileParametersSchema = z.object({
  path: z.string().describe('File path relative to workspace root'),
  start_line: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Starting line number (1-indexed). If not provided, reads from the beginning.'),
  end_line: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Ending line number (1-indexed, inclusive). If not provided, reads to the end.'),
});

export type ReadFileToolParams = z.infer<typeof readFileParametersSchema>;

export const formatReadFileCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const filePath = args?.path ?? 'unknown';
  const startLine = args?.start_line;
  const endLine = args?.end_line;

  let command = `read_file "${filePath}"`;
  if (startLine !== undefined || endLine !== undefined) {
    const start = startLine ?? 1;
    const end = endLine ?? 'end';
    command += ` --lines ${start}-${end}`;
  }

  const output = getOutputText(item) || 'No output';
  const success = !output.startsWith('Error:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'read_file',
      toolArgs: args,
    }),
  ];
};

import { ExecutionContext } from '../../services/execution-context.js';

export const createReadFileToolDefinition = (
  deps: {
    executionContext?: ExecutionContext;
    allowOutsideWorkspace?: boolean;
    orchestratorMode?: boolean;
  } = {},
): ToolDefinition<ReadFileToolParams> => {
  const { executionContext, allowOutsideWorkspace = false, orchestratorMode = false } = deps;
  return {
    name: 'read_file',
    description: orchestratorMode
      ? READ_FILE_DESCRIPTION_ORCHESTRATOR
      : allowOutsideWorkspace
      ? READ_FILE_DESCRIPTION_OUTSIDE
      : READ_FILE_DESCRIPTION,
    parameters: readFileParametersSchema,
    needsApproval: () => false, // Read-only operation, safe
    execute: async (params) => {
      const { path: filePath, start_line, end_line } = params;
      const cwd = executionContext?.getCwd() || process.cwd();

      try {
        // In Lite Mode we may allow reading outside the current workspace.
        const absolutePath = resolveWorkspacePath(filePath, cwd, {
          allowOutsideWorkspace,
        });

        // Read file content
        let content: string;
        const sshService = executionContext?.getSSHService();
        if (executionContext?.isRemote() && sshService) {
          content = await sshService.readFile(absolutePath);
        } else {
          content = await fs.readFile(absolutePath, 'utf8');
        }

        // Handle empty file
        if (content === '') {
          return '';
        }

        // Split into lines
        const lines = content.split('\n');
        const totalLines = lines.length;

        // Parse line range (auto-fill if omitted)
        const fromLine = start_line || 1;
        const toLine = end_line || totalLines;

        // Filter lines based on start_line and end_line
        let filteredLines = lines;
        if (start_line !== undefined || end_line !== undefined) {
          const startIdx = start_line ? start_line - 1 : 0;
          const endIdx = end_line ? end_line : lines.length;
          filteredLines = lines.slice(startIdx, endIdx);
        }

        // Create header with file path, line count, and line range
        const header = `File: ${filePath} (${totalLines} lines) [lines ${fromLine}-${toLine}]\n${'='.repeat(3)}\n`;

        // Join and trim output
        const fileContent = filteredLines.join('\n');
        const result = header + fileContent;
        return trimOutput(result);
      } catch (error: any) {
        // Handle errors gracefully
        if (error.message?.includes('outside workspace')) {
          return `Error: ${error.message}`;
        }
        if (error.code === 'ENOENT') {
          return `Error: File not found: ${filePath}`;
        }
        if (error.code === 'EACCES') {
          return `Error: Permission denied: ${filePath}`;
        }
        if (error.code === 'EISDIR') {
          return `Error: Path is a directory: ${filePath}`;
        }
        return `Error: ${error.message || String(error)}`;
      }
    },
    formatCommandMessage: formatReadFileCommandMessage,
  };
};
