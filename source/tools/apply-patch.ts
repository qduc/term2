import { z } from 'zod';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { applyDiff } from '@openai/agents';
import { resolveWorkspacePath } from './utils.js';
import type { ToolDefinition, CommandMessage, FormatCommandMessage } from './types.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import { getOutputText, safeJsonParse, normalizeToolArguments, createBaseMessage } from './format-helpers.js';
import { ExecutionContext } from '../services/execution-context.js';
import { withFileLock } from './file-locks.js';
import { TOOL_NAME_APPLY_PATCH } from './tool-names.js';

/**
 * Error thrown when patch validation fails (malformed diff)
 */
export class PatchValidationError extends Error {
  constructor(message: string, public filePath: string) {
    super(message);
    this.name = 'PatchValidationError';
  }
}

const applyPatchOperationSchema = z.object({
  type: z.enum(['create_file', 'update_file']),
  path: z.string().min(1, 'File path cannot be empty'),
  diff: z.string().describe('Unified diff content for create/update operations'),
});

const applyPatchParametersSchema = z
  .object({
    type: z.enum(['create_file', 'update_file']).optional(),
    path: z.string().min(1, 'File path cannot be empty').optional(),
    diff: z.string().describe('Unified diff content for create/update operations').optional(),
    operations: z.array(applyPatchOperationSchema).min(1).optional(),
  })
  .superRefine((params, ctx) => {
    const hasBatch = Array.isArray(params.operations);
    const hasSingle = params.type !== undefined || params.path !== undefined || params.diff !== undefined;

    if (hasBatch && hasSingle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either operations or a single type/path/diff operation, not both.',
      });
      return;
    }

    if (!hasBatch && (params.type === undefined || params.path === undefined || params.diff === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide operations or all single operation fields: type, path, and diff.',
      });
    }
  });

export type ApplyPatchToolParams = z.infer<typeof applyPatchParametersSchema>;
type ApplyPatchOperation = z.infer<typeof applyPatchOperationSchema>;
type ApplyPatchOutput = {
  success: boolean;
  operation?: string;
  path?: string;
  message?: string;
  error?: string;
};

function getApplyPatchOperations(params: ApplyPatchToolParams): ApplyPatchOperation[] {
  if (params.operations) {
    return params.operations;
  }
  return [
    {
      type: params.type!,
      path: params.path!,
      diff: params.diff!,
    },
  ];
}

export const formatApplyPatchCommandMessage: FormatCommandMessage = (item, index, _toolCallArgumentsById) => {
  const parsedOutput = safeJsonParse(getOutputText(item));
  const patchOutputItems = parsedOutput?.output ?? [];

  // If JSON parsing failed or no output array, create error message
  if (patchOutputItems.length === 0) {
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args = normalizeToolArguments(normalizedArgs) ?? {};
    const operationType = args?.type ?? 'unknown';
    const filePath = args?.path ?? 'unknown';
    const command = `apply_patch ${operationType} ${filePath}`;
    const output = getOutputText(item) || 'No output';
    const success = false;

    return [
      createBaseMessage(item, index, 0, false, {
        command,
        output,
        success,
        toolName: TOOL_NAME_APPLY_PATCH,
        toolArgs: { path: filePath, diff: args?.diff ?? '', type: operationType },
      }),
    ];
  }

  // Apply patch tool can have multiple operation outputs
  const messages: CommandMessage[] = [];
  for (const [patchIndex, patchResult] of patchOutputItems.entries()) {
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args = normalizeToolArguments(normalizedArgs) ?? {};
    const operationArgs = Array.isArray(args?.operations) ? args.operations[patchIndex] : args;
    const operationType = operationArgs?.type ?? patchResult?.operation ?? 'unknown';
    const filePath = operationArgs?.path ?? patchResult?.path ?? 'unknown';

    const command = `apply_patch ${operationType} ${filePath}`;
    const output = patchResult?.message ?? patchResult?.error ?? 'No output';
    const success = patchResult?.success ?? false;

    messages.push(
      createBaseMessage(item, index, patchIndex, false, {
        command,
        output,
        success,
        toolName: TOOL_NAME_APPLY_PATCH,
        toolArgs: { path: filePath, diff: operationArgs?.diff ?? '', type: operationType },
      }),
    );
  }
  return messages;
};

export function createApplyPatchToolDefinition(deps: {
  loggingService: ILoggingService;
  settingsService: ISettingsService;
  executionContext?: ExecutionContext;
}): ToolDefinition<ApplyPatchToolParams> {
  const { loggingService, settingsService, executionContext } = deps;

  return {
    name: 'apply_patch',
    description:
      'Apply file changes using headerless V4A diff format. Supports creating, updating files.\n\n' +
      '## CRITICAL RULES:\n' +
      '1. Each line MUST start with exactly one character: space, +, or - (followed by the line content)\n' +
      '2. Use @@ markers to provide context anchors when needed\n' +
      '3. Context lines (unchanged) start with a SPACE character\n' +
      '4. Added lines start with + character\n' +
      '5. Removed lines start with - character\n' +
      '6. DO NOT include line numbers or @@ -n,m +n,m @@ headers (headerless format)\n\n' +
      '## CREATE_FILE:\n' +
      'Every line must start with + (no context or - lines):\n' +
      '```\n' +
      '+line 1\n' +
      '+line 2\n' +
      '+line 3\n' +
      '```\n\n' +
      '## UPDATE_FILE:\n' +
      'Provide context (space-prefixed lines) around changes. Include 2-3 lines of context before and after:\n' +
      '```\n' +
      '@@ function calculate\n' +
      ' function calculate(x) {\n' +
      '-  return x * 2;\n' +
      '+  return x * 3;\n' +
      ' }\n' +
      '```\n\n' +
      '## Context Anchors:\n' +
      'Use @@ markers to help locate code in the file:\n' +
      '- For classes: @@ class ClassName\n' +
      '- For functions: @@ function functionName\n' +
      '- For unique lines: @@ distinctive text from the line\n' +
      'Stack multiple @@ for nested structures:\n' +
      '```\n' +
      '@@ class MyClass\n' +
      '@@ method doSomething\n' +
      ' def doSomething(self):\n' +
      '-    old code\n' +
      '+    new code\n' +
      '```\n\n' +
      '## Common Mistakes to Avoid:\n' +
      '- Missing space/+/- prefix on lines\n' +
      '- Including line numbers like "@@ -1,3 +1,4 @@"\n' +
      '- Not providing enough context (need 2-3 lines before/after)\n' +
      '- Context lines not starting with space character\n' +
      '- Using tabs instead of spaces for indentation matching',
    parameters: applyPatchParametersSchema,
    needsApproval: async (params) => {
      try {
        const workspaceRoot = executionContext?.getCwd() || process.cwd();
        const sshService = executionContext?.getSSHService();
        const isRemote = executionContext?.isRemote() && !!sshService;
        const operations = getApplyPatchOperations(params);

        for (const { type, path: filePath, diff } of operations) {
          // Resolve and ensure target within workspace before any validation.
          // This prevents validation from running against a mismatched cwd.
          let targetPath: string;
          try {
            targetPath = resolveWorkspacePath(filePath, workspaceRoot);
          } catch (e: any) {
            // Outside workspace => require approval
            loggingService.security('apply_patch needsApproval: outside workspace', {
              type,
              path: filePath,
              error: e?.message || String(e),
            });
            return true;
          }

          // Validate diff syntax by attempting a dry-run (before approval)
          if (type === 'create_file' || type === 'update_file') {
            try {
              if (type === 'create_file') {
                // Dry-run: apply diff to empty content for new file
                applyDiff('', diff);
              } else {
                // Dry-run: read existing file and test diff application.
                // Read failures are environment/file-state issues, not
                // deterministic patch syntax failures.
                const original =
                  isRemote && sshService ? await sshService.readFile(targetPath) : await readFile(targetPath, 'utf8');
                applyDiff(original, diff);
              }
              loggingService.debug('apply_patch validation passed', {
                type,
                path: filePath,
              });
            } catch (diffError: any) {
              // Keep fast UX for deterministic patch-format errors, but
              // require approval for environment/file-state failures.
              const fileAccessFailure =
                typeof diffError?.code === 'string' ||
                ['enoent', 'not found', 'no such file', 'permission denied', 'eacces', 'eperm', 'is a directory'].some(
                  (token) =>
                    String(diffError?.message || '')
                      .toLowerCase()
                      .includes(token),
                );

              if (fileAccessFailure) {
                loggingService.warn('apply_patch prevalidation could not confirm patch due to file/context issue', {
                  type,
                  path: filePath,
                  error: diffError?.message || String(diffError),
                });
                return true;
              }

              // Diff-format validation failed - auto-approve and let execute
              // return a structured error without bothering the user.
              loggingService.error('apply_patch validation failed - will fail in execute', {
                type,
                path: filePath,
                error: diffError?.message || String(diffError),
              });
              // Return false to auto-approve - execute will handle the error gracefully
              return false;
            }
          }

          // Deletions ALWAYS require approval per policy
          // if (type === 'delete_file') {
          //     loggingService.security('apply_patch needsApproval: delete requires approval', {
          //         mode,
          //         type,
          //         path: filePath,
          //     });
          //     return true;
          // }

          const insideCwd = targetPath.startsWith(workspaceRoot + path.sep);

          if (!insideCwd || (type !== 'create_file' && type !== 'update_file')) {
            loggingService.security('apply_patch needsApproval: approval required', {
              type,
              path: filePath,
              targetPath,
              insideCwd,
            });
            return true;
          }
        }

        loggingService.security('apply_patch needsApproval: auto-approved in standard mode', {
          operationCount: operations.length,
        });
        return false;
      } catch (error: any) {
        loggingService.error('apply_patch needsApproval error', {
          error: error?.message || String(error),
        });
        // Fail-safe: require approval on any error
        return true;
      }
    },
    execute: async (params) => {
      const enableFileLogging = settingsService.get<boolean>('tools.logFileOperations');
      const cwd = executionContext?.getCwd() || process.cwd();
      const sshService = executionContext?.getSSHService();
      const isRemote = executionContext?.isRemote() && !!sshService;

      const readFileFn = async (p: string) => {
        if (isRemote && sshService) return sshService.readFile(p);
        return readFile(p, 'utf8');
      };

      const writeFileFn = async (p: string, c: string) => {
        if (isRemote && sshService) return sshService.writeFile(p, c);
        return writeFile(p, c, 'utf8');
      };

      const mkdirFn = async (p: string) => {
        if (isRemote && sshService) return sshService.mkdir(p);
        return mkdir(p, { recursive: true });
      };

      const runOperation = async ({ type, path: filePath, diff }: ApplyPatchOperation) => {
        const targetPath = resolveWorkspacePath(filePath, cwd);

        if (enableFileLogging) {
          loggingService.debug(`File operation started: ${type}`, {
            path: filePath,
            targetPath,
          });
        }

        switch (type) {
          case 'create_file': {
            return withFileLock(targetPath, async () => {
              // Ensure parent directory exists
              await mkdirFn(path.dirname(targetPath));

              // Apply diff to empty content for new file
              let content: string;
              try {
                content = applyDiff('', diff);
              } catch (err: any) {
                return {
                  success: false,
                  operation: 'create_file',
                  path: filePath,
                  error: formatPatchError(err, diff, ''),
                };
              }
              await writeFileFn(targetPath, content);

              if (enableFileLogging) {
                try {
                  loggingService.debug('File created', {
                    path: filePath,
                    contentLength: content.length,
                  });
                } catch (error) {
                  // Ignore logging errors to prevent operation failure
                }
              }

              return {
                success: true,
                operation: 'create_file',
                path: filePath,
                message: `Created ${filePath}`,
              };
            });
          }

          case 'update_file': {
            return withFileLock(targetPath, async () => {
              // Read existing file
              let original: string;
              try {
                original = await readFileFn(targetPath);
              } catch (error: any) {
                if (error?.code === 'ENOENT') {
                  if (enableFileLogging) {
                    loggingService.error('Cannot update missing file', {
                      path: filePath,
                      targetPath,
                    });
                  }
                  return {
                    success: false,
                    operation: 'update_file',
                    path: filePath,
                    error: `Cannot update missing file: ${filePath}`,
                  };
                }

                throw error;
              }

              // Re-apply validation against the locked, current content.
              let patched: string;
              try {
                patched = applyDiff(original, diff);
              } catch (err: any) {
                return {
                  success: false,
                  operation: 'update_file',
                  path: filePath,
                  error: formatPatchError(err, diff, original),
                };
              }
              await writeFileFn(targetPath, patched);

              if (enableFileLogging) {
                try {
                  loggingService.debug('File updated', {
                    path: filePath,
                    originalLength: original.length,
                    patchedLength: patched.length,
                  });
                } catch (error) {
                  // Ignore logging errors to prevent operation failure
                }
              }

              return {
                success: true,
                operation: 'update_file',
                path: filePath,
                message: `Updated ${filePath}`,
              };
            });
          }

          default: {
            return {
              success: false,
              error: `Unknown operation type: ${type}`,
            };
          }
        }
      };

      try {
        const output: ApplyPatchOutput[] = [];
        for (const operation of getApplyPatchOperations(params)) {
          try {
            output.push(await runOperation(operation));
          } catch (operationError: any) {
            loggingService.error('Patch operation failed in execute', {
              type: operation.type,
              path: operation.path,
              error: operationError?.message || String(operationError),
            });
            output.push({
              success: false,
              error: `Invalid patch: ${
                operationError?.message || String(operationError)
              }. Please check the file path and diff format.`,
            });
          }
        }

        return JSON.stringify({ output });
      } catch (error: any) {
        if (enableFileLogging) {
          loggingService.error('File operation failed', {
            type: params.type ?? 'batch',
            path: params.path ?? 'multiple',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return JSON.stringify({
          output: [
            {
              success: false,
              error: error.message || String(error),
            },
          ],
        });
      }
    },
    formatCommandMessage: formatApplyPatchCommandMessage,
  };
}

/**
 * Helper to analyze why a context block failed to match the original file content.
 */
export function diagnoseContextMismatch(contextText: string, original: string): string {
  const contextLines = contextText.split(/\r?\n/);
  const originalLines = original.split(/\r?\n/);

  if (originalLines.length === 0 || (originalLines.length === 1 && originalLines[0] === '')) {
    return 'The target file is empty. If you want to create a new file, use type: "create_file" or provide a diff that starts from an empty file.';
  }

  const reports: string[] = [];

  for (let i = 0; i < contextLines.length; i++) {
    const contextLine = contextLines[i];
    const trimmedContext = contextLine.trim();
    if (!trimmedContext) continue;

    // Find any line in original that matches when trimmed
    const matchIndices: number[] = [];
    originalLines.forEach((origLine, idx) => {
      if (origLine.trim() === trimmedContext) {
        matchIndices.push(idx);
      }
    });

    if (matchIndices.length === 0) {
      reports.push(`- Line ${i + 1}: "${trimmedContext}" could not be found anywhere in the file.`);
    } else {
      // Check if ANY of the matches in the original file are exact matches (including indentation)
      const exactMatch = matchIndices.some((idx) => originalLines[idx] === contextLine);
      if (!exactMatch) {
        // Find if any match has matching indentation
        const sameIndentMatch = matchIndices.find((idx) => {
          const origIndent = originalLines[idx].match(/^\s*/)?.[0] || '';
          const contextIndent = contextLine.match(/^\s*/)?.[0] || '';
          return origIndent === contextIndent;
        });

        if (sameIndentMatch !== undefined) {
          const origLine = originalLines[sameIndentMatch];
          reports.push(
            `- Line ${i + 1}: Whitespace mismatch for "${trimmedContext}". Diff has "${contextLine.replace(
              / /g,
              '·',
            )}" but file has "${origLine.replace(/ /g, '·')}" on line ${sameIndentMatch + 1}.`,
          );
        } else {
          const matchIdx = matchIndices[0];
          const origLine = originalLines[matchIdx];
          const contextIndent = contextLine.match(/^\s*/)?.[0] || '';
          const origIndent = origLine.match(/^\s*/)?.[0] || '';
          const displayContextIndent = contextIndent.replace(/ /g, '·').replace(/\t/g, '→');
          const displayOrigIndent = origIndent.replace(/ /g, '·').replace(/\t/g, '→');
          reports.push(
            `- Line ${
              i + 1
            }: Indentation mismatch for "${trimmedContext}". Diff expected "${displayContextIndent}" but file has "${displayOrigIndent}" on line ${
              matchIdx + 1
            }.`,
          );
        }
      }
    }
  }

  let diagnosis = 'Patch failed: the context block was not found in the file.\n';
  if (reports.length > 0) {
    diagnosis += 'Mismatch details:\n' + reports.slice(0, 5).join('\n');
    if (reports.length > 5) {
      diagnosis += `\n... and ${reports.length - 5} more line mismatches.`;
    }
  } else {
    diagnosis +=
      'The lines exist individually, but not in the same order or location. Make the block contiguous and match the file.';
  }

  return diagnosis;
}

/**
 * Format errors from applyDiff to be clearer and more actionable.
 */
export function formatPatchError(error: Error, diff: string, original?: string): string {
  const message = error.message || String(error);
  let formatted = '';

  // 1. Check for standard unified diff headers: "--- a/file" or "+++ b/file"
  if (diff.includes('--- ') || diff.includes('+++ ')) {
    formatted = 'Remove standard file headers. Use headerless anchors with context, + lines, and - lines only.';
  }
  // 2. Check for unified diff chunk headers with line numbers: "@@ -1,5 +1,6 @@"
  else if (/@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(diff)) {
    formatted = 'Remove line numbers from "@@" headers. Use headerless anchors like "@@ functionName" or a bare "@@".';
  }
  // 3. Check for leading line numbers like "10: const x = 1;" or "10  const x = 1;"
  else if (
    diff.split(/\r?\n/).some((line) => /^\s*\d+[:\s]/.test(line) && !line.startsWith('@@') && !line.startsWith('***'))
  ) {
    formatted = 'Remove leading line numbers from patch lines.';
  }
  // 4. Check for invalid line prefix (missing space, +, -, or @@)
  else {
    const lines = diff.split(/\r?\n/);
    let invalidPrefixLine = -1;
    let invalidLineContent = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        line.startsWith('@@') ||
        line.trim() === '' ||
        line.startsWith('***') ||
        line === '*** End Patch' ||
        line === '*** End of File'
      ) {
        continue;
      }
      if (line[0] !== ' ' && line[0] !== '+' && line[0] !== '-') {
        invalidPrefixLine = i + 1;
        invalidLineContent = line;
        break;
      }
    }

    if (invalidPrefixLine !== -1) {
      formatted = `Line ${invalidPrefixLine} starts with '${invalidLineContent[0]}'. Use only space, +, -, or @@ prefixes.`;
    }
    // 5. Handle "Invalid Context" / "Invalid EOF Context" errors
    else {
      const contextMatch = message.match(/^Invalid (?:EOF )?Context \d+:\n([\s\S]*)$/);
      if (contextMatch && original !== undefined) {
        const contextText = contextMatch[1];
        formatted = diagnoseContextMismatch(contextText, original);
      }
      // 6. Handle "Invalid Line" error
      else {
        const invalidLineMatch = message.match(/^Invalid Line:\s*([\s\S]*)$/);
        if (invalidLineMatch) {
          const invalidLine = invalidLineMatch[1].trim();
          formatted = `Invalid line: "${invalidLine}". Use only space, +, -, or @@ prefixes.`;
        }
      }
    }
  }

  if (formatted) {
    return `Invalid patch: ${formatted}`;
  }

  // 7. General cleanup for any other error
  return `Invalid patch: ${message}. Please check the file path and diff format.`;
}
