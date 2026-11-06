import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { WireInteraction, WireQuestion, WireQuestionAnswer } from '../../protocol/wire.js';

import type { AcpAnswer } from './contract.js';

const stopped = (source: 'user' | 'system' = 'system'): AcpAnswer => ({
  decision: { kind: 'decline', stopAfterApprovalResolution: true },
  provenance: { source },
});

type Field = { readonly question: WireQuestion; readonly key: string; readonly customKey: string };

function property(question: WireQuestion): acp.ElicitationPropertySchema {
  const labels = question.options.map((option) => option.label);
  if (question.multiple)
    return {
      type: 'array',
      title: question.prompt,
      minItems: 1,
      items: { type: 'string', enum: labels },
    };
  return {
    type: 'string',
    title: question.prompt,
    oneOf: question.options.map((option) => ({
      const: option.label,
      title: option.label,
      ...(option.description ? { description: option.description } : {}),
    })),
  };
}

function form(interaction: WireInteraction): { schema: acp.ElicitationSchema; fields: readonly Field[] } {
  const questions = interaction.questions;
  if (!questions?.length)
    return {
      schema: {
        type: 'object',
        properties: { answer: { type: 'string', title: interaction.summary, minLength: 1 } },
        required: ['answer'],
      },
      fields: [],
    };
  const fields = questions.map((question, index) => ({ question, key: `q${index}`, customKey: `q${index}_custom` }));
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  const required: string[] = [];
  for (const { question, key, customKey } of fields) {
    if (question.options.length) properties[key] = property(question);
    if (question.allowCustom)
      properties[customKey] = {
        type: 'string',
        title: question.options.length ? `${question.prompt} — custom answer` : question.prompt,
        minLength: 1,
      };
    if (!question.allowCustom) {
      if (!question.options.length) throw new Error('Question has no supported answer field');
      required.push(key);
    } else if (!question.options.length) required.push(customKey);
  }
  return { schema: { type: 'object', properties, required }, fields };
}

function answers(fields: readonly Field[], content: Record<string, unknown>): readonly WireQuestionAnswer[] {
  const keys = new Set(fields.flatMap((field) => [field.key, field.customKey]));
  if (Object.keys(content).some((key) => !keys.has(key))) throw new Error('Unknown question field');
  return fields.map(({ question, key, customKey }) => {
    const selected = content[key];
    const custom = content[customKey];
    if (custom !== undefined && (typeof custom !== 'string' || !custom.trim() || !question.allowCustom)) {
      throw new Error('Invalid custom answer');
    }
    if (selected !== undefined && (question.multiple ? !Array.isArray(selected) : typeof selected !== 'string')) {
      throw new Error('Answer shape does not match the requested field');
    }
    const values = selected === undefined ? [] : typeof selected === 'string' ? [selected] : selected;
    if (
      !Array.isArray(values) ||
      (!question.multiple && values.length > 1) ||
      values.some((value) => typeof value !== 'string' || !question.options.some((option) => option.label === value))
    ) {
      throw new Error('Invalid selected answer');
    }
    if (!question.multiple && custom !== undefined && values.length) throw new Error('Choose one answer source');
    const combined = [...values, ...(typeof custom === 'string' ? [custom] : [])];
    if (!combined.length || new Set(combined).size !== combined.length) throw new Error('Missing or duplicate answer');
    return { questionId: question.id, value: question.multiple ? combined : combined[0] };
  });
}

/**
 * Use standard ACP v2 form elicitation, resolving the entire wire question set
 * once by stable IDs. Decline differs from cancel/invalid/unsupported responses;
 * those request stop-after-resolution rather than fabricate approval denial.
 */
export async function requestQuestion(input: {
  readonly sessionId: string;
  readonly interaction: WireInteraction;
  readonly client: acp.AgentContext;
  readonly signal: AbortSignal;
}): Promise<AcpAnswer> {
  try {
    const { schema, fields } = form(input.interaction);
    const response = await input.client.request(
      acp.methods.client.elicitation.create,
      {
        mode: 'form',
        sessionId: input.sessionId,
        ...(input.interaction.executionId ? { toolCallId: input.interaction.executionId } : {}),
        message: input.interaction.detail ?? input.interaction.summary,
        requestedSchema: schema,
      },
      { cancellationSignal: input.signal },
    );
    if (input.signal.aborted) return stopped();
    if (response.action === 'decline') return { decision: { kind: 'decline' }, provenance: { source: 'user' } };
    if (response.action === 'cancel') return stopped('user');
    if (
      response.action !== 'accept' ||
      !response.content ||
      typeof response.content !== 'object' ||
      Array.isArray(response.content)
    )
      return stopped();
    const content = response.content as Record<string, unknown>;
    if (fields.length)
      return { decision: { kind: 'answers', answers: answers(fields, content) }, provenance: { source: 'user' } };
    if (Object.keys(content).length !== 1 || typeof content.answer !== 'string' || !content.answer.trim())
      return stopped();
    return { decision: { kind: 'answer', answer: content.answer }, provenance: { source: 'user' } };
  } catch {
    return stopped();
  }
}
