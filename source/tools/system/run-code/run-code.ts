import { z } from 'zod';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { relaxedNumber } from '../../utils.js';
import { executeShellCommand } from '../../../utils/shell/execute-shell.js';
import { createSandboxEnvironment } from '../../../utils/shell/sandbox/sandbox-env.js';
import { ensureSandboxTempDir, SANDBOX_TEMP_DIR } from '../../../utils/shell/temp-dir.js';
import {
  SANDBOX_ESCAPE_INSTRUCTION,
  createSandboxRuntimeConfig,
  type ShellSandboxRunner,
} from '../../../utils/shell/sandbox/sandbox-policy.js';
import { getDefaultShellSandboxRunner } from '../../../utils/shell/sandbox/shell-sandbox-runner.js';
import { getProjectAllowReadStore } from '../../../utils/shell/sandbox/denied-read-stores.js';
import type { ILoggingService, ISettingsService } from '../../../services/service-interfaces.js';
import type { FormatCommandMessage, SchemaToolDefinition, ToolRegistry } from '../../types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from '../../format-helpers.js';
import { ToolBridgeServer, type ToolBridgeCallRecord } from './tool-bridge.js';
import { buildRunnerSource, generateRuntime } from './runtime-module.js';

export const TOOL_NAME_RUN_CODE = 'run_code';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

export const runCodeParametersSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'TypeScript source executed as the body of an async function. Top-level await is available. ' +
        'Use `return` only inside your own functions; print results with console.log.',
    ),
  timeout_ms: relaxedNumber.optional().describe(`Wall-clock limit for the script. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  description: z.string().optional().describe('One short line describing what the script does, shown to the user.'),
});

export type RunCodeParams = z.infer<typeof runCodeParametersSchema>;

const RUN_CODE_DESCRIPTION =
  'Write a TypeScript program and execute it inside the shell sandbox. Every tool you already have is available ' +
  "inside the script as `tools.<tool_name>(params)`, which returns a promise resolving to that tool's normal result. " +
  'Prefer this over many separate tool calls when the work is a loop, a fan-out over many files, or a multi-step ' +
  'computation whose intermediate values you do not need to see. Print what you want back with console.log; only ' +
  'stdout and stderr are returned. A tool that would require user approval cannot run from inside a script — call ' +
  'that tool directly instead.';

export interface CreateRunCodeToolOptions {
  settingsService: ISettingsService;
  loggingService: ILoggingService;
  /**
   * Resolves the live tool registry. It is a callback because the registry is
   * assembled after this definition exists, and because tools can be masked by
   * capability toggles while a session runs.
   */
  getToolRegistry: () => ToolRegistry;
  getCwd?: () => string;
  shellSandboxRunner?: ShellSandboxRunner;
  /** Overrides the `tsx` binary path; tests use this to avoid a real transpile. */
  tsxPath?: string;
}

const summarizeCalls = (calls: readonly ToolBridgeCallRecord[]): string => {
  if (calls.length === 0) return 'no tool calls';
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.tool, (counts.get(call.tool) ?? 0) + 1);
  const parts = [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool}×${count}` : tool));
  return `${calls.length} tool call${calls.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
};

const clip = (text: string): string =>
  text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated: output exceeded ${MAX_OUTPUT_CHARS} characters]`;

export const formatRunCodeCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const description = typeof args?.description === 'string' ? args.description : undefined;
  const code = typeof args?.code === 'string' ? args.code : '';
  const output = getOutputText(item) || 'No output';

  return [
    createBaseMessage(item, index, 0, false, {
      command: description ? `run_code — ${description}` : 'run_code',
      output,
      success: !output.startsWith('Error:'),
      toolName: TOOL_NAME_RUN_CODE,
      toolArgs: { ...args, code },
    }),
  ];
};

export function createRunCodeToolDefinition(
  options: CreateRunCodeToolOptions,
): SchemaToolDefinition<typeof runCodeParametersSchema> {
  const {
    settingsService,
    loggingService,
    getToolRegistry,
    getCwd = () => process.cwd(),
    shellSandboxRunner = getDefaultShellSandboxRunner(),
    tsxPath,
  } = options;

  const isSandboxEnabled = () => settingsService.get('sandbox.enabled') !== false;

  return {
    name: TOOL_NAME_RUN_CODE,
    description: RUN_CODE_DESCRIPTION,
    parameters: runCodeParametersSchema,
    effect: 'mutating',
    // The sandbox is the safety boundary, exactly as it is for a default shell
    // command, and every tool the script reaches is re-checked individually by
    // the bridge. Without a sandbox there is no boundary left, so ask.
    needsApproval: async () => {
      if (!isSandboxEnabled()) return true;
      const availability = await shellSandboxRunner.availability();
      return availability.type !== 'available';
    },
    execute: async (params) => {
      const { code, timeout_ms, description } = params;
      const cwd = getCwd();
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;

      if (!isSandboxEnabled()) {
        return 'Error: run_code requires the sandbox. Enable sandbox.enabled or use the shell tool instead.';
      }
      const availability = await shellSandboxRunner.availability();
      if (availability.type !== 'available') {
        return `Error: ${SANDBOX_ESCAPE_INSTRUCTION}`;
      }

      // The script must not be able to call run_code recursively: each nested
      // run would start its own bridge and sandbox, with no budget spanning them.
      const registry = getToolRegistry().filter((tool) => tool.name !== TOOL_NAME_RUN_CODE);
      const calls: ToolBridgeCallRecord[] = [];
      const bridge = new ToolBridgeServer({
        registry,
        onCall: (record) => calls.push(record),
      });

      ensureSandboxTempDir();
      const runDir = await mkdtemp(path.join(SANDBOX_TEMP_DIR, 'run-code-'));
      let sandboxLeaseRelease: (() => void) | undefined;

      try {
        const socketPath = await bridge.start();
        const runtime = generateRuntime({ registry, socketPath });
        const runnerPath = path.join(runDir, 'main.ts');
        // The run directory sits outside any package, so tsx would default it to
        // CommonJS and reject the top-level await the runner depends on.
        await writeFile(path.join(runDir, 'package.json'), '{"type":"module"}\n', 'utf8');
        await writeFile(path.join(runDir, 'tools.ts'), runtime.toolsModule, 'utf8');
        await writeFile(runnerPath, buildRunnerSource(runtime.runnerModule, code), 'utf8');

        loggingService.debug('run_code execution started', {
          cwd,
          runDir,
          timeout,
          exposedTools: registry.length,
          description,
        });

        const tsx = tsxPath ?? path.join(cwd, 'node_modules', '.bin', 'tsx');
        const command = `${JSON.stringify(tsx)} ${JSON.stringify(runnerPath)}`;

        if (shellSandboxRunner.acquire) sandboxLeaseRelease = await shellSandboxRunner.acquire();
        const sandboxConfig = createSandboxRuntimeConfig({
          cwd,
          tmpDir: SANDBOX_TEMP_DIR,
          readPolicy: settingsService.get('sandbox.readPolicy'),
          allowNetworking: settingsService.get('sandbox.allowNetworking') === true,
          toolBridgeSocketPath: socketPath,
          allowReadExtra: [
            ...(settingsService.get('sandbox.allowReadExtra') ?? []),
            ...getProjectAllowReadStore(cwd).load(),
          ],
        });

        let wrapped: string;
        try {
          wrapped = (await shellSandboxRunner.wrap(command, { cwd, config: sandboxConfig })).command;
        } catch (error) {
          loggingService.warn('run_code sandbox initialization failed; refusing unsandboxed fallback', {
            error: error instanceof Error ? error.message : String(error),
          });
          return `Error: ${SANDBOX_ESCAPE_INSTRUCTION}`;
        }

        const result = await executeShellCommand(wrapped, {
          cwd,
          timeout,
          env: createSandboxEnvironment(process.env, {
            cwd,
            tmpDir: SANDBOX_TEMP_DIR,
            readPolicy: settingsService.get('sandbox.readPolicy'),
          }),
        });

        loggingService.debug('run_code execution finished', {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          toolCalls: calls.length,
        });

        return renderResult(result, calls, timeout);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        sandboxLeaseRelease?.();
        shellSandboxRunner.cleanupAfterCommand?.();
        await bridge.stop();
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    formatCommandMessage: formatRunCodeCommandMessage,
  };
}

function renderResult(
  result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean },
  calls: readonly ToolBridgeCallRecord[],
  timeout: number,
): string {
  const sections: string[] = [];
  if (result.timedOut) sections.push(`Script timed out after ${timeout}ms.`);
  else if (result.exitCode !== 0) sections.push(`Script exited with code ${result.exitCode}.`);

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) sections.push(stdout);
  if (stderr) sections.push(`stderr:\n${stderr}`);
  if (!stdout && !stderr) sections.push('Script produced no output.');

  const refused = calls.filter((call) => call.outcome === 'approval_required');
  if (refused.length > 0) {
    const names = [...new Set(refused.map((call) => call.tool))].join(', ');
    sections.push(`Refused (needs user approval, call these directly instead): ${names}`);
  }
  sections.push(`[${summarizeCalls(calls)}]`);

  return clip(sections.join('\n\n'));
}
