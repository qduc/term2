import { z } from 'zod';
import * as fs from 'fs/promises';
import { resolveWorkspacePath, relaxedNumber } from '../utils.js';
import type { ScriptedToolDefinition, FormatCommandMessage } from '../types.js';
import { isReadPreApproved } from './read-access.js';
import { readFileGlobPathNote } from './glob-path-hint.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import type { FileReadAccessPort, NestedReadAccessPort } from '../access-port.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  isSuccessOutput,
} from '../format-helpers.js';
import {
  boundToolResultText,
  isScriptedToolCall,
  looksLikeBinary,
  resolveResultMaxBytesForCall,
} from '../../shared/utils/output/bound-tool-result.js';
import { saveOutputArtifact } from '../../shared/utils/shell/shell-output.js';

const READ_FILE_DESCRIPTION =
  'Read a file, optionally a 1-indexed line range; images return as image content. ' +
  'Prefer whole files (under 1,000 lines) or large windows to small chunks. ' +
  'Not for cross-file search (inside run_code, use tools.grep(...)). ' +
  'Large results are truncated; read the "Full output saved to" path for the rest.';
const READ_FILE_DESCRIPTION_OUTSIDE =
  'Read a file anywhere on the filesystem, optionally a 1-indexed line range; images return as image content. ' +
  'Prefer whole files (under 1,000 lines) or large windows to small chunks. ' +
  'Large results are truncated; read the "Full output saved to" path for the rest.';
const READ_FILE_DESCRIPTION_ORCHESTRATOR =
  'Inspect a known file directly, including to understand a small or clear area of the workspace. ' +
  'Image files are returned as image content for visual models. ' +
  'Delegate broad or separable exploration when it provides meaningful context compression or specialization. ' +
  'Supports line ranges — read the smallest relevant range. ' +
  'Returns the file path, total line count, and the requested lines. ' +
  'Large results are truncated and the full payload is saved to a file; look for "Full output saved to" and read that path when you need more.';

const SAVED_NOTE_MARKER = '\nFull output saved to';

const readFileHeader = (filePath: string, totalLines: number, range: string): string =>
  `File: ${filePath} (${totalLines} lines) [${range}]\n===\n`;

/**
 * What the model reads when `boundToolResultText` cut a read_file result. The cut text still opens with a header for
 * the whole requested range, so this rebuilds the result from the numbered lines: as many whole lines as fit in
 * `maxBytes`, a header and a `[truncated: ...]` marker (as run_code has) that name the lines present, and the
 * saved-output note the cut text ends with. A file that is one long line keeps the start of that line.
 */
function markReadFileCut(params: {
  cutText: string;
  numberedLines: readonly string[];
  header: { filePath: string; totalLines: number; fromLine: number; toLine: number };
  maxBytes: number;
}): string {
  const { cutText, numberedLines, maxBytes } = params;
  const { filePath, totalLines, fromLine, toLine } = params.header;
  const noteStart = cutText.lastIndexOf(SAVED_NOTE_MARKER);
  if (noteStart < 0) return cutText;
  const note = cutText.slice(noteStart + 1);
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
  const build = (body: string, shown: string): string =>
    `${readFileHeader(filePath, totalLines, `${shown} of ${fromLine}-${toLine}, truncated`)}${body}\n` +
    `[truncated: showing ${shown} of ${fromLine}-${toLine}; the rest was cut to fit the output limit.]\n${note}`;

  const wholeLines = (count: number) => `lines ${fromLine}-${fromLine + count - 1}`;
  // Sized with the widest range text, so the count found here still fits once its own range is written.
  const budget = maxBytes - bytes(build('', wholeLines(numberedLines.length)));
  let used = 0;
  let count = 0;
  for (const line of numberedLines) {
    const cost = bytes(line) + (count > 0 ? 1 : 0);
    if (used + cost > budget) break;
    used += cost;
    count += 1;
  }
  if (count > 0) return build(numberedLines.slice(0, count).join('\n'), wholeLines(count));

  // Not even the first line fits: show its start and say so, rather than nothing.
  const partial = `the start of line ${fromLine}`;
  const room = maxBytes - bytes(build('', partial));
  // Too small a limit for the marker itself: the cut text is within the limit, keep it.
  if (room <= 0) return cutText;
  let start = (numberedLines[0] ?? '').slice(0, room);
  while (bytes(start) > room) start = start.slice(0, -1);
  return build(start.replace(/[\uD800-\uDBFF]$/, ''), partial);
}

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
  path: z.string().describe('Relative to the workspace root.'),
  start_line: relaxedNumber.int().positive().optional().describe('1-indexed; give a range when you know it.'),
  end_line: relaxedNumber.int().positive().optional().describe('Inclusive.'),
});

export type ReadFileToolParams = z.infer<typeof readFileParametersSchema>;

const formatReadFileCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
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

import { ExecutionContext } from '../execution-context.js';

/**
 * The exact value a script receives from a read: the raw-text envelope, the
 * empty string an empty file has always returned, or the content-part array an
 * image read returns. Media payloads are replaced by an inert reference marker
 * (or an omission notice) before a script sees them, so a text part, that
 * marker, and a string are the only reachable array elements.
 */
const readFileScriptedReturnSchema = z.union([
  z
    .object({
      path: z.string(),
      totalLines: z.number(),
      fromLine: z.number(),
      toLine: z.number(),
      content: z.string(),
      truncated: z.boolean(),
      fullOutputPath: z.string().optional(),
    })
    .strict(),
  z.array(
    z.union([
      z.object({ type: z.literal('text'), text: z.string() }).strict(),
      z.object({ __term2_run_code_media_reference__: z.string() }).strict(),
      z.string(),
    ]),
  ),
  z.string(),
]);

export const createReadFileToolDefinition = (
  deps: {
    executionContext?: ExecutionContext;
    allowOutsideWorkspace?: boolean;
    orchestratorMode?: boolean;
    /** Root clients receive this handle-owned capability. */
    sessionAccess?: FileReadAccessPort;
    /** Isolated legacy protocol for nested tools only. */
    nestedCompatibility?: NestedReadAccessPort;
    /** YOLO (autoApproveMode 'always') read bypass. */
    settingsService?: ISettingsService;
    /** Optional override for the result byte cap (tests). */
    maxResultBytes?: number;
  } = {},
): ScriptedToolDefinition<typeof readFileParametersSchema> => {
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
    scriptedReturnShape:
      '{ path, totalLines, fromLine, toLine, content, truncated, fullOutputPath? } for text; content parts for an image; an "Error: …" string on error',
    description: orchestratorMode
      ? READ_FILE_DESCRIPTION_ORCHESTRATOR
      : allowOutsideWorkspace
      ? READ_FILE_DESCRIPTION_OUTSIDE
      : READ_FILE_DESCRIPTION,
    scriptedReturnSchema: readFileScriptedReturnSchema,
    parameters: readFileParametersSchema,
    canRequireApproval: true,
    parallelSafe: true,
    needsApproval: async (params, context) =>
      !(await isReadPreApproved({
        path: params.path,
        context,
        executionContext,
        allowOutsideWorkspace,
        settingsService,
        sessionAccess,
        nestedCompatibility,
      })),
    execute: async (params, context) => {
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
          const message =
            `File appears to be binary and was not loaded into context: ${filePath} ` +
            `(${buffer.length} bytes). Use shell tools or a specialized binary viewer if you need its contents.`;
          if (isScriptedToolCall(context)) {
            throw new Error(message);
          }
          return `Error: ${message}`;
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
        const header = readFileHeader(filePath, totalLines, `lines ${fromLine}-${toLine}`);

        // Add line numbers to each line
        const numberedLines = filteredLines.map((line, idx) => {
          return `${fromLine + idx}: ${line}`;
        });

        const fileContent = numberedLines.join('\n');
        const fullResult = header + fileContent;

        // A script gets the raw text and the counts as fields. The text form
        // prepends a "File: … (N lines)" banner and an "N: " prefix per line,
        // which every observed script had to strip by hand, and it reports
        // truncation as a trailing sentence a script will not branch on.
        if (isScriptedToolCall(context)) {
          const maxBudget = resolveResultMaxBytesForCall(context, maxResultBytes);
          const rawContent = filteredLines.join('\n');
          const fullEnvelope = {
            path: filePath,
            totalLines,
            fromLine,
            toLine,
            content: rawContent,
            truncated: false,
          };

          if (Buffer.byteLength(JSON.stringify(fullEnvelope), 'utf8') <= maxBudget) {
            return fullEnvelope;
          }

          let artifactPath: string | undefined;
          try {
            artifactPath = await saveOutputArtifact(rawContent, { filenamePrefix: 'read-file' });
          } catch {
            // Artifact saving failure leaves fullOutputPath undefined
          }

          let template: {
            path: string;
            totalLines: number;
            fromLine: number;
            toLine: number;
            content: string;
            truncated: boolean;
            fullOutputPath?: string;
          } = {
            path: filePath,
            totalLines,
            fromLine,
            toLine,
            content: '',
            truncated: true,
            ...(artifactPath ? { fullOutputPath: artifactPath } : {}),
          };

          // If template with fullOutputPath exceeds budget, drop fullOutputPath
          if (Buffer.byteLength(JSON.stringify(template), 'utf8') > maxBudget && artifactPath) {
            template = {
              path: filePath,
              totalLines,
              fromLine,
              toLine,
              content: '',
              truncated: true,
            };
          }

          const minBytes = Buffer.byteLength(JSON.stringify(template), 'utf8');
          if (minBytes > maxBudget) {
            throw new Error(
              `Result envelope exceeds budget of ${maxBudget} bytes (minimum required: ${minBytes} bytes).`,
            );
          }

          let low = 0;
          let high = rawContent.length;
          let bestSlice = '';

          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            let candidate = rawContent.slice(0, mid);
            if (/[\uD800-\uDBFF]$/.test(candidate)) {
              candidate = candidate.slice(0, -1);
            }
            if (Buffer.byteLength(JSON.stringify({ ...template, content: candidate }), 'utf8') <= maxBudget) {
              bestSlice = candidate;
              low = mid + 1;
            } else {
              high = mid - 1;
            }
          }

          while (
            bestSlice.length > 0 &&
            Buffer.byteLength(JSON.stringify({ ...template, content: bestSlice }), 'utf8') > maxBudget
          ) {
            bestSlice = bestSlice.slice(0, -1);
            if (/[\uD800-\uDBFF]$/.test(bestSlice)) {
              bestSlice = bestSlice.slice(0, -1);
            }
          }

          return {
            ...template,
            content: bestSlice,
          };
        }

        const bounded = await boundToolResultText({
          fullText: fullResult,
          // A scripted read is not bound by the context cap: the script sees
          // this value, not the model, and a silent partial read makes
          // whatever the script computes from it wrong.
          maxBytes: resolveResultMaxBytesForCall(context, maxResultBytes),
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
        if (!bounded.truncated) return bounded.text;
        // The cut text still opens with a header for the whole range: say which lines it actually holds.
        return markReadFileCut({
          cutText: bounded.text,
          numberedLines,
          header: { filePath, totalLines, fromLine, toLine },
          maxBytes: resolveResultMaxBytesForCall(context, maxResultBytes),
        });
      } catch (error: any) {
        if (isScriptedToolCall(context)) {
          if (error.code === 'ENOENT') {
            throw new Error(
              `File not found: ${filePath}${readFileGlobPathNote(
                filePath,
                executionContext?.getCwd() || process.cwd(),
              )}`,
            );
          }
          if (error.code === 'EISDIR') {
            throw new Error(`Path is a directory: ${filePath}`);
          }
          if (error.code === 'EACCES') {
            throw new Error(`Permission denied: ${filePath}`);
          }
          if (error.message?.includes('outside workspace')) {
            throw new Error(error.message);
          }
          throw error;
        }
        // Handle errors gracefully
        if (error.message?.includes('outside workspace')) {
          return `Error: ${error.message}`;
        }
        if (error.code === 'ENOENT') {
          return `Error: File not found: ${filePath}${readFileGlobPathNote(
            filePath,
            executionContext?.getCwd() || process.cwd(),
          )}`;
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
