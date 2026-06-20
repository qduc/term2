import { z } from 'zod';
import type { ToolDefinition, FormatCommandMessage } from '../types.js';
import { getOutputText, normalizeToolArguments, createBaseMessage, getCallIdFromItem } from '../format-helpers.js';
import { isAbortLike } from '../../services/subagents/utils.js';

const ASK_MENTOR_DESCRIPTION =
  'Ask a mentor model for advice or clarification on a hard problem. ' +
  'Use this for architecture trade-offs, design review, debugging strategy, or when you need a second opinion. ' +
  'The mentor does not see your thinking, files, or conversation context—fully explain the situation in your question. ' +
  'Do NOT use this to perform actions, read files, or run commands; use the standard tools for those. ' +
  'Returns the mentor answer as text.';

const askMentorSchema = z.object({
  question: z.string().describe('The question to ask the mentor.'),
  context: z.string().optional().describe('Additional context for the question.'),
});

export type AskMentorParams = z.infer<typeof askMentorSchema>;

export const formatAskMentorCommandMessage: FormatCommandMessage = (item, index, toolCallArgumentsById) => {
  const callId = getCallIdFromItem(item);
  const fallbackArgs = callId && toolCallArgumentsById.has(callId) ? toolCallArgumentsById.get(callId) : null;
  const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
  const args = normalizeToolArguments(normalizedArgs) ?? normalizeToolArguments(fallbackArgs) ?? {};

  const question = args?.question ?? 'Unknown question';
  const command = `ask_mentor: ${question}`;
  const output = getOutputText(item) || 'No response from mentor';
  const success = !output.startsWith('Failed to ask mentor:');

  return [
    createBaseMessage(item, index, 0, false, {
      command,
      output,
      success,
      toolName: 'ask_mentor',
      toolArgs: args,
    }),
  ];
};

export const createAskMentorToolDefinition = (
  askMentor: (question: string) => Promise<string>,
): ToolDefinition<AskMentorParams> => ({
  name: 'ask_mentor',
  description: ASK_MENTOR_DESCRIPTION,
  parameters: askMentorSchema,
  needsApproval: () => false,
  execute: async ({ question, context }) => {
    const prompt = context ? `Context:\n${context}\n\nQuestion:\n${question}` : question;
    try {
      const answer = await askMentor(prompt);
      return answer;
    } catch (error: any) {
      if (isAbortLike(error?.message, error)) {
        throw error;
      }
      return `Failed to ask mentor: ${error.message}. Ensure mentor model is configured in settings.`;
    }
  },
  formatCommandMessage: formatAskMentorCommandMessage,
});
