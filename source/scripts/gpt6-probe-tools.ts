import type { StreamedModelFunctionTool } from '../contracts/streamed-model-turn.js';

const stringField = (description: string) => ({ type: 'string', description });
const schema = (properties: Record<string, ReturnType<typeof stringField>>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const shell: StreamedModelFunctionTool = {
  name: 'shell',
  description: 'Execute a shell command. Do not use for applying patch scripts.',
  strict: true,
  parameters: schema({ command: stringField('Single shell command to execute.') }, ['command']),
};
const askUser: StreamedModelFunctionTool = {
  name: 'ask_user',
  description: 'Ask the user for a decision or clarification.',
  strict: true,
  parameters: schema({ input: stringField('Question to ask the user.') }, ['input']),
};

export const mainProbeTools: StreamedModelFunctionTool[] = [
  {
    name: 'run_code',
    description: 'Execute JavaScript with tools.apply_patch available inside the script for file edits.',
    strict: true,
    parameters: schema(
      {
        code: stringField('JavaScript program to execute; call tools.apply_patch({ patch }) for edits.'),
        description: stringField('Short description of this script.'),
      },
      ['code', 'description'],
    ),
  },
  shell,
  askUser,
];

export const workerProbeTools: StreamedModelFunctionTool[] = [
  {
    name: 'apply_patch',
    description: 'Apply a complete patch script to files.',
    strict: true,
    parameters: schema({ patch: stringField('Complete patch script starting with *** Begin Patch.') }, ['patch']),
  },
  shell,
  askUser,
];
