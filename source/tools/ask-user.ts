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

const questionItemSchema = z
  .object({
    question: askUserTextSchema.describe('The question to ask the user.'),
    options: z
      .array(askUserOptionSchema)
      .min(2)
      .max(8)
      .optional()
      .describe(
        'Optional list of predefined choices. If provided, must have at least 2 options. The first option should be the recommended/default choice.',
      ),
    is_multi_select: z
      .boolean()
      .optional()
      .describe('If true, the user can select multiple options instead of just one.'),
  })
  .refine((data) => !data.is_multi_select || (data.options !== undefined && data.options.length >= 2), {
    message: 'is_multi_select requires at least 2 options',
  });

const askUserSchema = z.object({
  questions: z.array(questionItemSchema).min(1).max(5).describe('A list of clarifying questions to ask the user.'),
});

export type AskUserParams = z.infer<typeof askUserSchema>;

export const createAskUserToolDefinition = (
  getAskUserAnswer: (callId?: string) => string | undefined,
): ToolDefinition => ({
  name: TOOL_NAME_ASK_USER,
  description:
    'Ask the user clarifying questions when missing user decisions block correct progress or when proceeding would require guessing materially important requirements. ' +
    'Provide concise options when possible; the first option must be the recommended/default choice. ' +
    'If the user declines to answer, proceed using the safest reasonable defaults and state the assumptions in your final response.',
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

  let command = 'ask_user';
  if (parsedArgs.success) {
    const qList = parsedArgs.data.questions.map((q) => q.question);
    if (qList.length === 1) {
      command = `ask_user: ${qList[0]}`;
    } else {
      command = `ask_user: [${qList.join(', ')}]`;
    }
  } else {
    command = `ask_user: Unknown questions`;
  }

  const rawOutput = getOutputText(item);
  let output = rawOutput || ASK_USER_NO_RESPONSE_DISPLAY;

  // Try to parse the answers if it's a JSON array, to render them nicely
  if (rawOutput && parsedArgs.success) {
    try {
      const parsedAnswers = JSON.parse(rawOutput);
      if (Array.isArray(parsedAnswers) && parsedAnswers.length === parsedArgs.data.questions.length) {
        const formattedLines = parsedArgs.data.questions.map((q, idx) => {
          const ans = parsedAnswers[idx];
          const ansStr = Array.isArray(ans) ? ans.join(', ') : String(ans);
          return `Question: ${q.question}\nAnswer: ${ansStr}`;
        });
        output = formattedLines.join('\n\n');
      } else if (Array.isArray(parsedAnswers)) {
        // Array length mismatch — render each answer on its own line
        output = parsedAnswers.map((ans) => (Array.isArray(ans) ? ans.join(', ') : String(ans))).join('\n');
      }
    } catch {
      // Not a JSON answer (e.g. ASK_USER_DECLINE_RESULT or ASK_USER_NO_ANSWER_RESULT)
    }
  }

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
