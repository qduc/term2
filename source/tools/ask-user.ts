import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from './types.js';
import { getCallIdFromItem, getOutputText, normalizeToolArguments, createBaseMessage } from './format-helpers.js';
import { TOOL_NAME_ASK_USER } from './tool-names.js';
import {
  ASK_USER_NO_ANSWER_RESULT,
  ASK_USER_NO_RESPONSE_DISPLAY,
  ASK_USER_RESERVED_OPTION_LABELS,
} from './ask-user-constants.js';

const reservedOptionLabels = new Set<string>(ASK_USER_RESERVED_OPTION_LABELS);

const askUserTextSchema = z.string().trim().min(1);

const askUserOptionSchema = askUserTextSchema.refine((value) => !reservedOptionLabels.has(value), {
  message: 'Option label is reserved by the ask_user UI.',
});

const askUserSchema = z.object({
  question: askUserTextSchema.describe('The clarifying question to ask the user.'),
  options: z
    .array(askUserOptionSchema)
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
    'If the user declines to answer, proceed using the safest reasonable default and state the assumption in your final response.',
  parameters: askUserSchema,
  needsApproval: () => true,
  execute: async (_params, _context, details) => {
    const callId = (details as any)?.toolCall?.callId;
    const answer = getAskUserAnswer(callId);
    if (answer === undefined) {
      return ASK_USER_NO_ANSWER_RESULT;
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
  const parsedArgs = askUserSchema.safeParse(args);

  const question = parsedArgs.success ? parsedArgs.data.question : 'Unknown question';
  const command = `ask_user: ${question}`;
  const rawOutput = getOutputText(item);
  const output = rawOutput || ASK_USER_NO_RESPONSE_DISPLAY;
  const success = Boolean(rawOutput) && rawOutput !== ASK_USER_NO_ANSWER_RESULT;

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
