/** Typed presentation and answer serialization for the existing ask_user tool schema.
 * Progress through questions is client-local; the complete answer set is resolved once
 * through Session.answer, which remains the only durable authority.
 */
import type { InteractionRequest } from '../engine/direct-types.js';
import type { WireQuestion, WireQuestionAnswer } from './direct-wire.js';
import { DirectProtocolError } from './direct-errors.js';

const reserved = new Set(['Something else… (type your answer)', 'Decline to answer', 'Submit answer']);
function plain(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Only interpret the known ask_user schema; other question tools retain their own presentation. */
export function interactionQuestions(request: InteractionRequest): readonly WireQuestion[] | undefined {
  if (request.kind !== 'question' || request.toolName !== 'ask_user') return undefined;
  const input = plain(request.input);
  if (!input || !Array.isArray(input.questions)) return undefined;
  return input.questions.map((raw, index) => {
    const question = plain(raw);
    if (!question || typeof question.question !== 'string')
      throw new DirectProtocolError('invalid_command', 'Question schema is unavailable.');
    const options = question.options === undefined ? [] : question.options;
    if (!Array.isArray(options)) throw new DirectProtocolError('invalid_command', 'Question options are invalid.');
    return {
      id: `${request.requestId}:question:${index}`,
      prompt: question.question,
      multiple: question.is_multi_select === true,
      allowCustom: true,
      options: options.map((rawOption) => {
        const option = plain(rawOption);
        if (!option || typeof option.label !== 'string' || reserved.has(option.label))
          throw new DirectProtocolError('invalid_command', 'Question option is invalid.');
        return {
          label: option.label,
          ...(typeof option.description === 'string' ? { description: option.description } : {}),
        };
      }),
    };
  });
}
/** Canonical source behavior serializes all answers, in question order, as a JSON array. */
export function serializeQuestionAnswers(request: InteractionRequest, answers: readonly WireQuestionAnswer[]): string {
  const questions = interactionQuestions(request);
  if (!questions || !questions.length)
    throw new DirectProtocolError('unavailable', 'Structured answers are unavailable for this question tool.');
  if (answers.length !== questions.length)
    throw new DirectProtocolError('invalid_command', 'Answer every question exactly once.');
  const byId = new Map(answers.map((answer) => [answer.questionId, answer.value]));
  if (byId.size !== answers.length) throw new DirectProtocolError('invalid_command', 'Duplicate question answer.');
  const values = questions.map((question) => {
    const value = byId.get(question.id);
    if (value === undefined || (Array.isArray(value) && !question.multiple))
      throw new DirectProtocolError('invalid_command', 'Answer shape does not match the question.');
    const entries = typeof value === 'string' ? [value] : value;
    if (!entries.length || entries.some((entry) => !entry.trim() || reserved.has(entry)))
      throw new DirectProtocolError('invalid_command', 'Question answers cannot be empty or reserved labels.');
    return value;
  });
  return JSON.stringify(values);
}
