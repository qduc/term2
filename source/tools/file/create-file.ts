import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { access, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { resolveWorkspacePath } from '../utils.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { TOOL_NAME_CREATE_FILE } from '../tool-names.js';
import type { ILoggingService, ISettingsService, ISSHService } from '../../services/service-interfaces.js';
import { getOutputText, safeJsonParse, normalizeToolArguments, createBaseMessage } from '../format-helpers.js';
import { ExecutionContext } from '../../services/execution-context.js';

const CREATE_FILE_DESCRIPTION =
  'Create a new file with the specified content. Replace existing files requires setting overwrite=true. ' +
  'Do NOT use this to edit existing files; use search_replace instead. ' +
  'Returns Created <path>, Overwrote <path>, or Error: <reason>.';

const createFileParametersSchema = z.object({
  path: z.string().describe('The absolute or relative path to the new file.'),
  content: z.string().describe('The initial content for the new file.'),
  overwrite: z.boolean().optional().default(false).describe('Whether to overwrite an existing file.'),
  confirmOverwriteCode: z
    .string()
    .optional()
    .describe(
      'The confirmation code from a previous failed attempt. Only use this param when you have received an error telling you to set it.',
    ),
});

export type CreateFileToolParams = z.input<typeof createFileParametersSchema>;

type PendingOverwrite = {
  path: string;
  targetPath: string;
  content: string;
  code: string;
  createdAt: number;
};

export const formatCreateFileCommandMessage: FormatCommandMessage = (item, index, _toolCallArgumentsById) => {
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? {};

  const filePath = args?.path ?? 'unknown';
  const command = `create_file "${filePath}"`;
  const rawOutput = getOutputText(item) || 'No output';

  // Backward compatibility: old outputs were JSON strings.
  const parsedOutput = rawOutput.startsWith('{') ? safeJsonParse(rawOutput) : undefined;
  const output =
    typeof parsedOutput?.message === 'string'
      ? parsedOutput.message
      : typeof parsedOutput?.error === 'string'
      ? parsedOutput.error
      : rawOutput;
  const success = typeof parsedOutput?.success === 'boolean' ? parsedOutput.success : !output.startsWith('Error:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: TOOL_NAME_CREATE_FILE,
      toolArgs: args,
    }),
  ];
};

export function createCreateFileToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
}): ToolDefinition<CreateFileToolParams> {
  const { loggingService, settingsService, executionContext } = deps;
  const pendingOverwrites = new Map<string, PendingOverwrite>();
  const pendingOverwriteTtlMs = 10 * 60 * 1000;

  const purgeStalePendingOverwrites = (now = Date.now()) => {
    for (const [targetPath, pending] of pendingOverwrites.entries()) {
      if (now - pending.createdAt > pendingOverwriteTtlMs) {
        pendingOverwrites.delete(targetPath);
      }
    }
  };

  const fileExists = async (targetPath: string, sshService?: ISSHService) => {
    if (sshService) {
      try {
        await sshService.readFile(targetPath);
        return true;
      } catch {
        return false;
      }
    }

    try {
      await access(targetPath);
      return true;
    } catch {
      return false;
    }
  };

  return {
    name: TOOL_NAME_CREATE_FILE,
    description: CREATE_FILE_DESCRIPTION,
    parameters: createFileParametersSchema,
    needsApproval: async (params) => {
      try {
        const { path: filePath } = params;
        const cwd = executionContext?.getCwd() || process.cwd();
        const targetPath = resolveWorkspacePath(filePath, cwd);
        const insideCwd = targetPath.startsWith(cwd + path.sep);

        // We auto-approve file creation within the workspace by default
        if (insideCwd) {
          return false;
        }
        return true;
      } catch (_error) {
        // Outside workspace or other error => require approval
        return true;
      }
    },
    execute: async (params) => {
      const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
      try {
        const { path: filePath, content, overwrite = false } = params;
        const cwd = executionContext?.getCwd() || process.cwd();
        // The workspace boundary was already enforced by `needsApproval` (which
        // returns true and pauses the SDK for an out-of-workspace path). If we
        // reach `execute` after the user approved, the write must proceed.
        const targetPath = resolveWorkspacePath(filePath, cwd, { allowOutsideWorkspace: true });

        const sshService = executionContext?.getSSHService();
        const isRemote = executionContext?.isRemote() && !!sshService;

        purgeStalePendingOverwrites();

        if (enableFileLogging) {
          loggingService.debug(`File operation started: create_file`, {
            path: filePath,
            targetPath,
          });
        }

        const exists = await fileExists(targetPath, isRemote ? sshService : undefined);

        if (exists && !overwrite) {
          const code = randomBytes(3).toString('hex');
          pendingOverwrites.set(targetPath, {
            path: filePath,
            targetPath,
            content,
            code,
            createdAt: Date.now(),
          });

          return `Error: File already exists at ${filePath}. To overwrite, call create_file again with overwrite=true and confirmOverwriteCode=${code}.`;
        }

        if (exists && overwrite) {
          const pending = pendingOverwrites.get(targetPath);

          // Validate confirmation code only when one is explicitly provided
          // (i.e. completing the two-step flow). When overwrite=true is used
          // without a code, overwrite directly regardless of stale pending entries.
          const confirmCode = params.confirmOverwriteCode === 'undefined' ? undefined : params.confirmOverwriteCode;
          if (confirmCode) {
            if (!pending || confirmCode !== pending.code) {
              return `Error: No matching overwrite confirmation exists for ${filePath}.`;
            }
          }

          // Use pending content when completing the two-step flow, otherwise use provided content
          const contentToWrite = confirmCode && pending ? pending.content : content;

          const parentDir = path.dirname(targetPath);
          if (isRemote && sshService) {
            await sshService.mkdir(parentDir, { recursive: true });
            await sshService.writeFile(targetPath, contentToWrite);
          } else {
            await mkdir(parentDir, { recursive: true });
            await writeFile(targetPath, contentToWrite, { encoding: 'utf8' });
          }

          // Invalidate pending code after successful write
          pendingOverwrites.delete(targetPath);

          if (enableFileLogging) {
            loggingService.debug('File overwritten', { path: filePath });
          }

          return `Overwrote ${filePath}`;
        }

        if (!exists) {
          pendingOverwrites.delete(targetPath);
        }

        // Ensure parent directory exists
        const parentDir = path.dirname(targetPath);
        if (isRemote && sshService) {
          await sshService.mkdir(parentDir, { recursive: true });
          await sshService.writeFile(targetPath, content);
        } else {
          await mkdir(parentDir, { recursive: true });
          // Use 'wx' flag to fail if file exists
          await writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
        }

        if (enableFileLogging) {
          loggingService.debug('File created', { path: filePath });
        }

        return `Created ${filePath}`;
      } catch (error: any) {
        if (enableFileLogging) {
          loggingService.error('File operation failed: create_file', {
            path: params.path,
            error: error.message || String(error),
          });
        }

        let errorMessage = error.message || String(error);
        if (error.code === 'EEXIST') {
          errorMessage = `Error: File already exists at ${params.path}. Use the overwrite confirmation flow to replace it.`;
        }

        return `Error: ${errorMessage}`;
      }
    },
    formatCommandMessage: formatCreateFileCommandMessage,
  };
}
