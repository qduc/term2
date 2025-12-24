import {z} from 'zod';
import type {ToolDefinition} from './types.js';

const askMentorSchema = z.object({
    question: z.string().describe('The question to ask the mentor.'),
    context: z.string().nullable().describe('Additional context for the question.'),
});

export type AskMentorParams = z.infer<typeof askMentorSchema>;

export const createAskMentorToolDefinition = (
    askMentor: (question: string) => Promise<string>
): ToolDefinition<AskMentorParams> => ({
    name: 'ask_mentor',
    description: 'Ask a mentor (a smarter model) for advice or clarification on a problem.',
    parameters: askMentorSchema,
    needsApproval: () => false,
    execute: async ({question, context}) => {
        const prompt = context ? `Context:\n${context}\n\nQuestion:\n${question}` : question;
        try {
            const answer = await askMentor(prompt);
            return answer;
        } catch (error: any) {
            return `Failed to ask mentor: ${error.message}. Ensure mentor model is configured in settings.`;
        }
    },
});
