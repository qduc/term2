import { describe, expect, it } from 'vitest';
import { toCodexResponsesInput, toCodexToolResultOutput } from './codex-turn-converter.js';

describe('Codex streamed-turn conversion', () => {
  it('converts each supported input item and rich tool result without string coercion', () => {
    expect(
      toCodexResponsesInput([
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'system' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'text', text: 'user' },
            { type: 'image', image: { id: 'file_image' }, detail: 'high' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'assistant' }] },
        {
          type: 'reasoning',
          id: 'rs_1',
          text: 'considered',
          providerMetadata: { codex: { encrypted_content: 'ciphertext' } },
        },
        { type: 'tool_call', id: 'call_1', name: 'lookup', arguments: '{"q":"term2"}' },
        {
          type: 'tool_result',
          id: 'call_1',
          output: [
            { type: 'text', text: 'result' },
            { type: 'image', image: { data: 'YWJj', mediaType: 'image/png' } },
            { type: 'file', file: { url: 'https://example.test/result.txt', filename: 'result.txt' } },
          ],
        },
      ]),
    ).toEqual([
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'system' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'user' },
          { type: 'input_image', file_id: 'file_image', detail: 'high' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'assistant' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'ciphertext',
        content: [{ type: 'reasoning_text', text: 'considered' }],
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"term2"}' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'result' },
          { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
          { type: 'input_file', file_url: 'https://example.test/result.txt', filename: 'result.txt' },
        ],
      },
    ]);
  });

  it('rejects foreign provider reasoning metadata instead of leaking it onto the Codex wire', () => {
    expect(() =>
      toCodexResponsesInput([
        {
          type: 'reasoning',
          text: 'foreign reasoning',
          providerMetadata: { openai_compatible_reasoning_content: true },
        },
      ]),
    ).toThrow('Unsupported foreign reasoning metadata for Codex: openai_compatible_reasoning_content');
  });

  it('rejects unsupported rich shapes before producing malformed Responses input', () => {
    expect(() =>
      toCodexResponsesInput([
        { type: 'message', role: 'assistant', content: [{ type: 'image', image: 'https://example.test/image.png' }] },
      ]),
    ).toThrow('Unsupported Codex assistant message content');
    expect(() =>
      toCodexToolResultOutput([{ type: 'file', file: { data: 'YWJj', mediaType: 'text/plain' } } as any]),
    ).toThrow('inline data requires a filename');
  });
});
