import type { StreamedModelTurnRequest } from '../../source/contracts/streamed-model-turn.js';

export const fixturePrompt = 'fixture prompt';
export const fixtureTool = {
  name: 'fixture',
  description: 'Returns deterministic fixture data.',
  parameters: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
} as const;
export const fixtureRequest: StreamedModelTurnRequest = {
  input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: fixturePrompt }] }],
  tools: [fixtureTool],
  reasoning: { effort: 'medium' },
};
export const multiTurnFixture = [
  { type: 'message', role: 'user', content: [{ type: 'text', text: 'first' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
  { type: 'message', role: 'user', content: [{ type: 'text', text: 'third' }] },
] as const;
