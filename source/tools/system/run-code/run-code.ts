import { z } from 'zod';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { relaxedNumber } from '../../utils.js';
import { executeShellCommand } from '../../../utils/shell/execute-shell.js';
import { ensureSandboxTempDir, SANDBOX_TEMP_DIR } from '../../../utils/shell/temp-dir.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { ToolInvocationContext } from '../../../services/agent-runtime/tool-invocation-context.js';
import type { AnyToolDefinition, FormatCommandMessage, SchemaToolDefinition, ToolRegistry } from '../../types.js';
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
  // A non-positive timeout disables the timer downstream, which would leave the
  // script, its bridge, and its temp directory alive forever.
  timeout_ms: relaxedNumber
    .int()
    .positive()
    .optional()
    .describe(`Wall-clock limit for the script. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  description: z.string().optional().describe('One short line describing what the script does, shown to the user.'),
});

export type RunCodeParams = z.infer<typeof runCodeParametersSchema>;

const RUN_CODE_DESCRIPTION =
  'Write a TypeScript program and execute it. Every tool you already have is available inside the script as ' +
  "`tools.<tool_name>(params)`, returning a promise that resolves to that tool's normal result. Prefer this over " +
  'many separate tool calls when the work is a loop, a fan-out over many files, or a multi-step computation whose ' +
  'intermediate values you do not need to see — only what you print reaches the conversation. Print results with ' +
  'console.log. Types are stripped, not checked, so use erasable syntax only: no enums, namespaces, or parameter ' +
  'properties. The script runs with the same privileges as this session, and each tools.* call is still subject to ' +
  "the tool's own approval and policy checks.";

export interface CreateRunCodeToolOptions {
  loggingService: ILoggingService;
  /**
   * Resolves the tools exposed to the script. Supplying it directly is a test
   * seam; in production {@link bindRunCodeRegistry} installs the wrapped
   * registry, so scripts go through the same policy layer as a direct call.
   */
  getToolRegistry?: () => ToolRegistry;
  getCwd?: () => string;
  /** Overrides the interpreter. Defaults to the Node binary running this process. */
  nodePath?: string;
}

/**
 * Marks a definition as accepting the final, wrapped tool registry.
 *
 * `run_code` is built in `agent.ts` from raw definitions, but the policy layer
 * (plan-mode interceptors, approval wrapping, post-execute hooks) is added
 * afterwards in `agent-factory.ts`. Handing the bridge the raw array would let a
 * script reach an implementation the harness had deliberately wrapped, so the
 * registry is injected after wrapping instead.
 */
const REGISTRY_BINDER = Symbol.for('term2.run_code.bindRegistry');

type RegistryBindable = { [REGISTRY_BINDER]?: (registry: ToolRegistry) => void };

/** Installs the wrapped registry into any `run_code` definition in `tools`. */
export function bindRunCodeRegistry(tools: ToolRegistry): void {
  for (const tool of tools) {
    (tool as RegistryBindable)[REGISTRY_BINDER]?.(tools);
  }
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

const FAILURE_PREFIXES = ['Error:', 'Script exited with code', 'Script timed out'];

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
      success: !FAILURE_PREFIXES.some((prefix) => output.startsWith(prefix)),
      toolName: TOOL_NAME_RUN_CODE,
      toolArgs: { ...args, code },
    }),
  ];
};

export function createRunCodeToolDefinition(
  options: CreateRunCodeToolOptions,
): SchemaToolDefinition<typeof runCodeParametersSchema> {
  const { loggingService, getCwd = () => process.cwd(), nodePath = process.execPath } = options;

  // Set by bindRunCodeRegistry once the policy layer has wrapped every tool.
  let boundRegistry: ToolRegistry | undefined;
  const resolveRegistry = (): ToolRegistry => options.getToolRegistry?.() ?? boundRegistry ?? [];

  const definition: SchemaToolDefinition<typeof runCodeParametersSchema> = {
    name: TOOL_NAME_RUN_CODE,
    description: RUN_CODE_DESCRIPTION,
    parameters: runCodeParametersSchema,
    effect: 'mutating',
    needsApproval: () => false,
    execute: async (params, context) => {
      const { code, timeout_ms, description } = params;
      const cwd = getCwd();
      const timeout = timeout_ms ?? DEFAULT_TIMEOUT_MS;
      const callerSignal = (context as ToolInvocationContext | undefined)?.signal;

      // A script must not start another script: each run owns a bridge and a
      // call budget, and nesting them would let one run spend many budgets.
      const registry = resolveRegistry().filter((tool) => tool.name !== TOOL_NAME_RUN_CODE);
      const calls: ToolBridgeCallRecord[] = [];
      const bridge = new ToolBridgeServer({
        registry,
        toolContext: context,
        onCall: (record) => calls.push(record),
      });

      ensureSandboxTempDir();
      const runDir = await mkdtemp(path.join(SANDBOX_TEMP_DIR, 'run-code-'));

      try {
        const socketPath = await bridge.start();
        const runtime = generateRuntime({ registry, socketPath });
        const runnerPath = path.join(runDir, 'main.ts');
        // The run directory sits outside any package, so Node would treat the
        // script as CommonJS and reject the top-level await the runner needs.
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

        const command = `${JSON.stringify(nodePath)} ${JSON.stringify(runnerPath)}`;
        const result = await executeShellCommand(command, { cwd, timeout, signal: callerSignal });

        loggingService.debug('run_code execution finished', {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          toolCalls: calls.length,
        });

        return renderResult(result, calls, timeout);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        // Settles every host-side call still running for a script that is
        // already gone, so nothing outlives the reported result.
        await bridge.stop();
        await rm(runDir, { recursive: true, force: true }).catch(() => {});
      }
    },
    formatCommandMessage: formatRunCodeCommandMessage,
  };

  (definition as AnyToolDefinition as RegistryBindable)[REGISTRY_BINDER] = (registry) => {
    boundRegistry = registry;
  };

  return definition;
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
