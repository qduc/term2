import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from './types.js';
import { getCallIdFromItem, getOutputText, normalizeToolArguments, createBaseMessage } from './format-helpers.js';
import { TOOL_NAME_ASK_USER } from './tool-names.js';

const askUserSchema = z.object({
  question: z.string().min(1).describe('The clarifying question to ask the user.'),
  options: z
    .array(z.string().min(1))
    .max(8)
    .optional()
    .describe(
      'Optional list of predefined choices for the user to choose from. The first option should be the recommended one.',
    ),
});

export type AskUserParams = z.infer<typeof askUserSchema>;

export const createAskUserToolDefinition = (
  getAskUserAnswer: (callId?: string) => string | undefined,
): ToolDefinition => ({
  name: TOOL_NAME_ASK_USER,
  description:
    'Ask the user a clarifying question when a missing user decision blocks correct progress or when proceeding would require guessing a materially important requirement. ' +
    'Provide concise options when possible; the first option must be the recommended/default choice. ' +
    'Do not add "Decline to answer" to the options array; the UI provides it automatically. ' +
    'If the user declines to answer, proceed using the safest reasonable default and state the assumption in your final response.',
  parameters: askUserSchema,
  needsApproval: () => true,
  execute: async (_params, _context, details) => {
    const callId = (details as any)?.toolCall?.callId;
    const answer = getAskUserAnswer(callId);
    if (answer === undefined) {
      return 'User did not provide an answer.';
    }
    return answer;
  },
  formatCommandMessage: formatAskUserCommandMessage,
});

export const formatAskUserCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const question = (args as any)?.question ?? 'Unknown question';
  const command = `ask_user: ${question}`;
  const output = getOutputText(item) || 'No response from user';
  const success = !output.startsWith('User did not provide an answer.');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: TOOL_NAME_ASK_USER,
      toolArgs: args,
    }),
  ];
};
