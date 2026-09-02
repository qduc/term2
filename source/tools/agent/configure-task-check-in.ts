import { z } from 'zod';
import { relaxedNumber } from '../utils.js';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import {
  getOutputText,
  normalizeToolArguments,
  createBaseMessage,
  getCallIdFromItem,
  safeJsonParse,
} from '../format-helpers.js';

export const MIN_CHECK_IN_INTERVAL_SECONDS = 300; // 5 minutes
export const MIN_NEXT_CHECK_IN_SECONDS = 30; // 30 seconds (scheduler tick granularity)

export const configureTaskCheckInSchema = z.object({
  target: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .describe(
      'The background task identifier: shell jobId (e.g. job-123) or subagent name/runId (e.g. explorer-1 or run-abc).',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe('Set to false to disable/mute future proactive check-ins for this task, or true to enable them.'),
  interval_seconds: relaxedNumber
    .int()
    .min(
      MIN_CHECK_IN_INTERVAL_SECONDS,
      `interval_seconds must be at least ${MIN_CHECK_IN_INTERVAL_SECONDS} seconds (5 minutes)`,
    )
    .optional()
    .describe(
      `Set a recurring interval in seconds between future check-ins for this task (minimum ${MIN_CHECK_IN_INTERVAL_SECONDS} seconds / 5 minutes).`,
    ),
  next_check_in_seconds: relaxedNumber
    .int()
    .min(MIN_NEXT_CHECK_IN_SECONDS, `next_check_in_seconds must be at least ${MIN_NEXT_CHECK_IN_SECONDS} seconds`)
    .optional()
    .describe(
      `Schedule the next check-in specifically after this many seconds from now (minimum ${MIN_NEXT_CHECK_IN_SECONDS} seconds).`,
    ),
});

export type ConfigureTaskCheckInParams = z.infer<typeof configureTaskCheckInSchema>;

export interface ConfigureTaskCheckInResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export function createConfigureTaskCheckInToolDefinition(
  configureTaskCheckIn: (params: ConfigureTaskCheckInParams) => ConfigureTaskCheckInResult,
): ToolDefinition {
  return {
    name: 'configure_task_check_in',
    description:
      'Configure or mute proactive check-ins for an active background shell job or subagent. ' +
      'Use this to mute future check-ins when a task is expected to run quietly until completion, or to adjust how frequently or when next you want to be checked in on.',
    parameters: configureTaskCheckInSchema,
    needsApproval: () => false,
    parallelSafe: true,
    execute: (rawParams) => {
      const parsed = configureTaskCheckInSchema.safeParse(rawParams);
      if (!parsed.success) {
        return JSON.stringify({
          ok: false,
          error: parsed.error.issues.map((i) => i.message).join('; '),
        });
      }
      try {
        const result = configureTaskCheckIn(parsed.data);
        return JSON.stringify(result);
      } catch (error: any) {
        return JSON.stringify({
          ok: false,
          error: error?.message || String(error),
        });
      }
    },
    formatCommandMessage: formatConfigureTaskCheckInCommandMessage,
  };
}

export const formatConfigureTaskCheckInCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ?? normalizeToolArguments(fallbackArgs) ?? {};
  const rawOutput = getOutputText(item);
  const result = safeJsonParse(rawOutput) as ConfigureTaskCheckInResult | null;
  const target = args.target ?? 'task';
  const success = result !== null && result.ok;

  const command = success
    ? `configure_task_check_in [${target}] — updated`
    : `configure_task_check_in [${target}] — failed`;

  const output = success
    ? result.message ?? `Check-in settings updated for ${target}.`
    : `Failed to configure check-in for ${target}: ${result?.error ?? rawOutput ?? 'unknown error'}`;

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'configure_task_check_in',
      toolArgs: args,
    }),
  ];
};
