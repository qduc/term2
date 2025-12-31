import {z} from 'zod';
import type {ToolDefinition, CommandMessage} from './types.js';
import {
    getOutputText,
    normalizeToolArguments,
    createBaseMessage,
    getCallIdFromItem,
} from './format-helpers.js';

const askMentorSchema = z.object({
    question: z.string().describe('The question to ask the mentor.'),
    context: z
        .string()
        .nullable()
        .describe('Additional context for the question.'),
});

export type AskMentorParams = z.infer<typeof askMentorSchema>;

export const formatAskMentorCommandMessage = (
    item: any,
    index: number,
    toolCallArgumentsById: Map<string, unknown>,
): CommandMessage[] => {
    const callId = getCallIdFromItem(item);
    const fallbackArgs =
        callId && toolCallArgumentsById.has(callId)
            ? toolCallArgumentsById.get(callId)
            : null;
    const normalizedArgs = item?.rawItem?.arguments ?? item?.arguments;
    const args =
        normalizeToolArguments(normalizedArgs) ??
        normalizeToolArguments(fallbackArgs) ??
        {};

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
    description:
        'Ask a mentor (a smarter model) for advice or clarification on a problem. The mentor does not see your thinking, files you have read, or conversation context - you must fully explain the situation in your question.',
    parameters: askMentorSchema,
    needsApproval: () => false,
    execute: async ({question, context}) => {
        const prompt = context
            ? `Context:\n${context}\n\nQuestion:\n${question}`
            : question;
        try {
            const answer = await askMentor(prompt);
            return answer;
        } catch (error: any) {
            return `Failed to ask mentor: ${error.message}. Ensure mentor model is configured in settings.`;
        }
    },
    formatCommandMessage: formatAskMentorCommandMessage,
});
