import { describe, expect, it } from 'vitest';
import { toCodexResponsesInput, toCodexResponsesItem, toCodexToolResultOutput } from './codex-turn-converter.js';

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
        {
          type: 'reasoning',
          id: 'rs_2',
          text: '',
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
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'system' }] },
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
        summary: [{ type: 'summary_text', text: 'considered' }],
        encrypted_content: 'ciphertext',
      },
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [],
        encrypted_content: 'ciphertext',
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

  it('rewrites system messages to user because Codex Responses forbids system in input', () => {
    const input = toCodexResponsesInput([
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'text',
            text: '[Compacted Conversation Context — untrusted historical data]\n<summary>\nprior work\n</summary>',
          },
        ],
      },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);

    expect(input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '[Compacted Conversation Context — untrusted historical data]\n<summary>\nprior work\n</summary>',
          },
        ],
      },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ]);
    expect(JSON.stringify(input)).not.toContain('"role":"system"');
  });

  it('replays OpenAI-lane opaque compaction items verbatim without role mapping', () => {
    const opaque = { type: 'compaction', state: 'server-state' };
    expect(
      toCodexResponsesInput([
        { type: 'provider_opaque', provider: 'openai', item: opaque },
        { type: 'message', role: 'system', content: [{ type: 'text', text: 'checkpoint' }] },
      ]),
    ).toEqual([opaque, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'checkpoint' }] }]);
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

  it('ensures explicit wire fields take precedence over providerMetadata keys', () => {
    expect(
      toCodexResponsesInput([
        {
          type: 'reasoning',
          id: 'rs_canonical',
          text: 'valid text',
          providerMetadata: { codex: { type: 'override', summary: 'invalid', encrypted_content: 'cipher' } as any },
        },
      ]),
    ).toEqual([
      {
        type: 'reasoning',
        id: 'rs_canonical',
        summary: [{ type: 'summary_text', text: 'valid text' }],
        encrypted_content: 'cipher',
      },
    ]);
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

describe('provider_opaque handling', () => {
  it('replays an OpenAI-lane compaction item so Codex native compaction can round-trip', () => {
    expect(
      toCodexResponsesInput([
        {
          type: 'provider_opaque',
          provider: 'openai',
          item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
        },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ]),
    ).toEqual([
      { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ]);
  });

  it('drops a foreign provider_opaque item and still serializes the rest', () => {
    const input = toCodexResponsesInput([
      { type: 'provider_opaque', provider: 'grok', item: { type: 'compaction', encrypted_content: 'foreign-blob' } },
      { type: 'message', role: 'user', content: [{ type: 'text', text: 'still here' }] },
    ]);

    expect(JSON.stringify(input)).not.toContain('foreign-blob');
    expect(input).toHaveLength(1);
  });

  it('drops a Codex-tagged provider_opaque item, which this lane tags as openai', () => {
    expect(
      toCodexResponsesInput([
        { type: 'provider_opaque', provider: 'codex', item: { type: 'compaction', encrypted_content: 'blob' } },
      ]),
    ).toEqual([]);
  });

  // The per-item converter keeps throwing so a future caller that bypasses the
  // filter cannot put a foreign payload on the wire unnoticed.
  it('still refuses a provider_opaque item handed straight to the per-item converter', () => {
    expect(() =>
      toCodexResponsesItem({
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', encrypted_content: 'blob' },
      } as never),
    ).toThrow(/provider_opaque/);
  });
});
