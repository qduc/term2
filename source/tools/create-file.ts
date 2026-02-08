import { z } from 'zod';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { resolveWorkspacePath } from './utils.js';
import type { ToolDefinition, CommandMessage } from './types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { getOutputText, safeJsonParse, normalizeToolArguments, createBaseMessage } from './format-helpers.js';
import { ExecutionContext } from '../services/execution-context.js';

const createFileParametersSchema = z.object({
  path: z.string().describe('The absolute or relative path to the new file'),
  content: z.string().describe('The initial content for the new file'),
});

export type CreateFileToolParams = z.infer<typeof createFileParametersSchema>;

export const formatCreateFileCommandMessage = (
  item: any,
  index: number,
  _toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
  const parsedOutput = safeJsonParse(getOutputText(item));
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? {};

  const filePath = args?.path ?? parsedOutput?.path ?? 'unknown';
  const command = `create_file "${filePath}"`;
  const output = parsedOutput?.message ?? parsedOutput?.error ?? (getOutputText(item) || 'No output');
  const success = parsedOutput?.success ?? !output.startsWith('Error:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'create_file',
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

  return {
    name: 'create_file',
    description: 'Create a new file with the specified content. Fails if the file already exists.',
    parameters: createFileParametersSchema,
    needsApproval: async (params) => {
      const editMode = settingsService.get<boolean>('app.editMode');
      const { path: filePath } = params;
      const cwd = executionContext?.getCwd() || process.cwd();
      const targetPath = resolveWorkspacePath(filePath, cwd);
      const insideCwd = targetPath.startsWith(cwd + path.sep);

      // In edit mode, we auto-approve file creation within the workspace
      if (editMode && insideCwd) {
        return false;
      }
      return true;
    },
    execute: async (params) => {
      const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
      try {
        const { path: filePath, content } = params;
        const cwd = executionContext?.getCwd() || process.cwd();
        const targetPath = resolveWorkspacePath(filePath, cwd);

        const sshService = executionContext?.getSSHService();
        const isRemote = executionContext?.isRemote() && !!sshService;

        if (enableFileLogging) {
          loggingService.info(`File operation started: create_file`, {
            path: filePath,
            targetPath,
          });
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
          loggingService.info('File created', { path: filePath });
        }

        return JSON.stringify({
          success: true,
          path: filePath,
          message: `Created ${filePath}`,
        });
      } catch (error: any) {
        if (enableFileLogging) {
          loggingService.error('File operation failed: create_file', {
            path: params.path,
            error: error.message || String(error),
          });
        }

        let errorMessage = error.message || String(error);
        if (error.code === 'EEXIST') {
          errorMessage = `Error: File already exists at ${params.path}. Use search_replace to modify existing files.`;
        }

        return JSON.stringify({
          success: false,
          error: errorMessage,
        });
      }
    },
    formatCommandMessage: formatCreateFileCommandMessage,
  };
}
