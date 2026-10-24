import assert from 'node:assert/strict';
import fc from 'fast-check';
import { OpenAIResponsesModelWithPromptCacheKey } from '../../source/providers/openai-responses-model.ts';
import { OpenAIChatCompletionsModel } from '../../source/providers/openai-chat-completions-model.ts';
import { toCodexResponsesInput } from '../../source/providers/codex-turn-converter.ts';

const entry = fc.record({
  lane: fc.constantFrom('openai', 'grok', 'chat-a', 'chat-b', 'openai-compatible'),
  origin: fc.constantFrom(null, 'openai', 'codex', 'chat-a', 'chat-b', 'grok'),
  text: fc.string(),
});

/** Capture the real adapter's serialized request at its SDK client boundary. */
async function wireInput(lane, input) {
  if (lane === 'codex') return toCodexResponsesInput(input);
  let captured;
  const responses = lane === 'openai' || lane === 'grok';
  const client = responses
    ? {
        responses: {
          create: async (payload) => {
            captured = payload.input;
            return (async function* () {
              yield { type: 'response.completed', response: { id: 'response', status: 'completed', output: [] } };
            })();
          },
        },
      }
    : {
        chat: {
          completions: {
            create: async (payload) => {
              captured = payload.messages;
              return (async function* () {
                yield { id: 'response', choices: [{ delta: {}, finish_reason: 'stop' }] };
              })();
            },
          },
        },
      };
  const adapter = responses
    ? new OpenAIResponsesModelWithPromptCacheKey(client, 'probe', {}, undefined, undefined, lane)
    : new OpenAIChatCompletionsModel(client, 'probe', undefined, lane);
  for await (const _event of adapter.stream({ input, tools: [] })) {
    /* consume real conversion */
  }
  assert.ok(captured, 'adapter did not reach client boundary');
  return captured;
}

export const opaqueProperties = [
  {
    name: 'opaque.lane-isolation',
    property: fc.asyncProperty(
      fc.array(entry, { maxLength: 30 }),
      fc.constantFrom('openai', 'codex', 'grok', 'chat-a', 'chat-b'),
      async (entries, target) => {
        const lane = target === 'codex' ? 'openai' : target;
        const input = [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'ordinary-user-content' }] }];
        const expected = [];
        entries.forEach((e, n) => {
          const sentinel = `OPAQUE_SENTINEL_${n}_END`;
          const payload =
            e.lane === 'openai' || e.lane === 'grok'
              ? { type: 'reasoning', encrypted_content: sentinel, summary: [] }
              : { reasoning_content: sentinel };
          // Disputed legacy -> Grok policy is intentionally not asserted.
          const omitted = target === 'grok' && e.lane === 'openai-compatible';
          if (!omitted)
            input.push({
              type: 'provider_opaque',
              provider: e.lane,
              ...(target.startsWith('chat-') || e.origin === null ? {} : { sourceProvider: e.origin }),
              item: payload,
            });
          // Every chat opaque payload belongs to its own adjacent assistant group.
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `ordinary-assistant-${n}:${e.text}` }],
          });
          const laneMatches = e.lane === lane || (target.startsWith('chat-') && e.lane === 'openai-compatible');
          // Backend-origin pins apply at Responses/Codex conversion. Chat lane tags
          // are already configured-provider identities, not shared wire identities.
          const originMatches = target.startsWith('chat-') || e.origin === null || e.origin === target;
          expected.push({ sentinel, survives: !omitted && laneMatches && originMatches, payload });
        });
        const before = structuredClone(input);
        const wire = await wireInput(target, input);
        const json = JSON.stringify(wire);
        assert.ok(json.includes('ordinary-user-content'), 'ordinary user history lost');
        entries.forEach((_, n) =>
          assert.ok(json.includes(`ordinary-assistant-${n}:`), 'ordinary assistant history lost'),
        );
        for (const { sentinel, survives, payload } of expected) {
          const count = json.split(sentinel).length - 1;
          assert.equal(count, survives ? 1 : 0, `opaque sentinel ${sentinel} crossed lane or was lost for ${target}`);
          if (survives && (target === 'openai' || target === 'codex' || target === 'grok'))
            assert.ok(
              wire.some((item) => JSON.stringify(item) === JSON.stringify(payload)),
              'own opaque payload changed',
            );
        }
        assert.deepEqual(input, before, 'adapter mutated opaque input');
      },
    ),
  },
];
