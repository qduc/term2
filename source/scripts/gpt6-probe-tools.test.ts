import { describe, expect, it } from 'vitest';
import { mainProbeTools, workerProbeTools } from './gpt6-probe-tools.js';

describe('GPT-6 prompt probe tool contracts', () => {
  it('exposes the main agent editor only through run_code, with distinct shell arguments', () => {
    expect(mainProbeTools.map((tool) => tool.name)).toEqual(['run_code', 'shell', 'ask_user']);
    expect(mainProbeTools[0]?.parameters).toMatchObject({
      properties: { code: { type: 'string' }, description: { type: 'string' } },
      required: ['code', 'description'],
    });
    expect(mainProbeTools[1]?.parameters).toMatchObject({
      properties: { command: { type: 'string' } },
      required: ['command'],
    });
  });

  it('gives a direct-editor worker a patch argument, not a shell input', () => {
    expect(workerProbeTools[0]?.parameters).toMatchObject({
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    });
  });
});
