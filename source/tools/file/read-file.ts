import { z } from 'zod';
import * as fs from 'fs/promises';
import { resolveWorkspacePath, relaxedNumber } from '../utils.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { isSessionReadGranted } from '../../services/approval/session-read-access.js';
import type { ISettingsService } from '../../services/service-interfaces.js';
import type { SessionAccessState } from '../../services/session/session-access-state.js';
import type { NestedToolCompatibilityState } from '../../services/session/nested-tool-compatibility-state.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  isSuccessOutput,
} from '../format-helpers.js';
import {
  boundToolResultText,
  looksLikeBinary,
  resolveToolResultMaxBytes,
} from '../../utils/output/bound-tool-result.js';

const READ_FILE_DESCRIPTION =
  'Read file content from the workspace (like cat command). Supports reading specific line ranges. ' +
  'Image files are returned as image content for visual models. ' +
  'Use this to inspect a known file or verify a specific claim about a location. ' +
  'Avoid reading tiny repeated chunks (e.g. 50 lines at a time); read the full file if it is under 1000 lines or use a larger window. ' +
  'Do NOT use this to search for text across files (use grep). ' +
  'Returns the file path, total line count, and the requested lines. ' +
  'Large results are truncated and the full payload is saved to a file; look for "Full output saved to" and read that path when you need more.';
const READ_FILE_DESCRIPTION_OUTSIDE =
  'Read file content from the filesystem (like cat command). Supports reading specific line ranges. ' +
  'Image files are returned as image content for visual models. ' +
  'Use this to inspect a known file or verify a specific claim about a location. ' +
  'Avoid reading tiny repeated chunks (e.g. 50 lines at a time); read the full file if it is under 1000 lines or use a larger window. ' +
  'Returns the file path, total line count, and the requested lines. ' +
  'Large results are truncated and the full payload is saved to a file; look for "Full output saved to" and read that path when you need more.';
const READ_FILE_DESCRIPTION_ORCHESTRATOR =
  'Inspect a known file directly, including to understand a small or clear area of the workspace. ' +
  'Image files are returned as image content for visual models. ' +
  'Delegate broad or separable exploration when it provides meaningful context compression or specialization. ' +
  'Supports line ranges — read the smallest relevant range. ' +
  'Returns the file path, total line count, and the requested lines. ' +
  'Large results are truncated and the full payload is saved to a file; look for "Full output saved to" and read that path when you need more.';

/** Detect image formats that the model adapters can send as image content. */
function detectImageMediaType(buffer: Buffer, filePath: string): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(Buffer.from([0x42, 0x4d]))) return 'image/bmp';
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))
  ) {
    return 'image/tiff';
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x00, 0x01, 0x00]))) return 'image/x-icon';
  if (
    /\.svg$/i.test(filePath) &&
    /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(buffer.toString('utf8', 0, Math.min(buffer.length, 512)))
  ) {
    return 'image/svg+xml';
  }
  return undefined;
}

const readFileParametersSchema = z.object({
  path: z.string().describe('File path relative to workspace root'),
  start_line: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Starting line number (1-indexed). Optional, specify when you know the exact range to read.'),
  end_line: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe('Ending line number (1-indexed, inclusive). Optional, specify when you know the exact range to read.'),
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
  const success = isSuccessOutput(output);

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
    /** Root clients receive this handle-owned capability. */
    sessionAccess?: SessionAccessState;
    /** Isolated legacy protocol for nested tools only. */
    nestedCompatibility?: NestedToolCompatibilityState;
    /** YOLO (autoApproveMode 'always') read bypass. */
    settingsService?: ISettingsService;
    /** Optional override for the result byte cap (tests). */
    maxResultBytes?: number;
  } = {},
): ToolDefinition<typeof readFileParametersSchema> => {
  const {
    executionContext,
    allowOutsideWorkspace = false,
    orchestratorMode = false,
    sessionAccess,
    nestedCompatibility,
    settingsService,
    maxResultBytes,
  } = deps;
  return {
    name: 'read_file',
    description: orchestratorMode
      ? READ_FILE_DESCRIPTION_ORCHESTRATOR
      : allowOutsideWorkspace
      ? READ_FILE_DESCRIPTION_OUTSIDE
      : READ_FILE_DESCRIPTION,
    parameters: readFileParametersSchema,
    canRequireApproval: true,
    parallelSafe: true,
    needsApproval: async (params, context) => {
      if (allowOutsideWorkspace) {
        return false;
      }

      // YOLO mode ('always') approves read-only operations without a prompt,
      // even outside the workspace. The shared tool wrapper applies the same
      // mode to mutating tools.
      if (settingsService?.get('shell.autoApproveMode') === 'always') {
        return false;
      }

      try {
        const cwd = executionContext?.getCwd() || process.cwd();
        const resolvedPath = resolveWorkspacePath(params.path, cwd, { allowOutsideWorkspace: true });
        if (isSessionReadGranted(resolvedPath, cwd, context, { sessionAccess, nestedCompatibility })) {
          return false;
        }

        resolveWorkspacePath(params.path, cwd, {
          allowDiscoveredSkillFolders: true,
        });
        return false;
      } catch {
        return true;
      }
    },
    execute: async (params) => {
      const { path: filePath, start_line, end_line } = params;
      const cwd = executionContext?.getCwd() || process.cwd();

      try {
        // The workspace boundary is enforced by needsApproval for the default mode.
        const absolutePath = resolveWorkspacePath(filePath, cwd, {
          allowOutsideWorkspace: true,
        });

        // Read as bytes first so binary files do not enter context as mojibake.
        let buffer: Buffer;
        const sshService = executionContext?.getSSHService();
        if (executionContext?.isRemote() && sshService) {
          const remoteContent = await sshService.readFile(absolutePath);
          buffer = Buffer.from(remoteContent, 'utf8');
        } else {
          buffer = await fs.readFile(absolutePath);
        }

        if (buffer.length === 0) {
          return '';
        }

        const imageMediaType = detectImageMediaType(buffer, filePath);
        if (imageMediaType) {
          return [
            {
              type: 'text',
              text: `Image: ${filePath} (${buffer.length} bytes, ${imageMediaType})`,
            },
            {
              type: 'image',
              image: { data: buffer.toString('base64'), mediaType: imageMediaType },
            },
          ];
        }

        if (looksLikeBinary(buffer)) {
          return (
            `Error: File appears to be binary and was not loaded into context: ${filePath} ` +
            `(${buffer.length} bytes). Use shell tools or a specialized binary viewer if you need its contents.`
          );
        }

        const content = buffer.toString('utf8');

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

        // Add line numbers to each line
        const numberedLines = filteredLines.map((line, idx) => {
          return `${fromLine + idx}: ${line}`;
        });

        const fileContent = numberedLines.join('\n');
        const fullResult = header + fileContent;

        const bounded = await boundToolResultText({
          fullText: fullResult,
          maxBytes: resolveToolResultMaxBytes(maxResultBytes),
          artifactContents: [
            `File: ${filePath}`,
            `Absolute path: ${absolutePath}`,
            `Total lines: ${totalLines}`,
            `Requested range: ${fromLine}-${toLine}`,
            '',
            fileContent,
            '',
          ].join('\n'),
        });
        return bounded.text;
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
