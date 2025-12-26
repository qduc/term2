import {z} from 'zod';
import * as fs from 'fs/promises';
import { resolveWorkspacePath, relaxedNumber } from './utils.js';
import {trimOutput} from '../utils/output-trim.js';
import type {ToolDefinition, CommandMessage} from './types.js';
import {
    getOutputText,
    normalizeToolArguments,
    createBaseMessage,
    getCallIdFromItem,
} from './format-helpers.js';

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

export const formatReadFileCommandMessage = (
    item: any,
    index: number,
    toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const callId = getCallIdFromItem(item);
    const fallbackArgs =
        callId && toolCallArgumentsById.has(callId)
            ? toolCallArgumentsById.get(callId)
            : null;
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args =
        normalizeToolArguments(normalizedArgs) ??
        normalizeToolArguments(fallbackArgs) ??
        {};

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

export const readFileToolDefinition: ToolDefinition<ReadFileToolParams> = {
    name: 'read_file',
    description:
        'Read file content from the workspace. Returns content with line numbers prefixed (like cat -n). Supports reading specific line ranges.',
    parameters: readFileParametersSchema,
    needsApproval: () => false, // Read-only operation, safe
    execute: async params => {
        const {path: filePath, start_line, end_line} = params;

        try {
            // Validate path is within workspace
            const absolutePath = resolveWorkspacePath(filePath);

            // Read file content
            const content = await fs.readFile(absolutePath, 'utf8');

            // Handle empty file
            if (content === '') {
                return '';
            }

            // Split into lines
            const lines = content.split('\n');

            // Filter lines based on start_line and end_line
            let filteredLines = lines;
            if (start_line !== undefined || end_line !== undefined) {
                const startIdx = start_line ? start_line - 1 : 0;
                const endIdx = end_line ? end_line : lines.length;
                filteredLines = lines.slice(startIdx, endIdx);
            }

            // Add line numbers (1-indexed)
            const startLineNum = start_line || 1;
            const numberedLines = filteredLines.map((line, idx) => {
                const lineNum = startLineNum + idx;
                return `${lineNum}\t${line}`;
            });

            // Join and trim output
            const result = numberedLines.join('\n');
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
