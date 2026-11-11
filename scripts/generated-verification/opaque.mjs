import assert from 'node:assert/strict';
import fc from 'fast-check';
import { OpenAIResponsesModelWithPromptCacheKey } from '../../src/model/providers/openai-responses-model.ts';
import { OpenAIChatCompletionsModel } from '../../src/model/providers/openai-chat-completions-model.ts';
import { toCodexResponsesInput } from '../../src/model/providers/codex-turn-converter.ts';
import { historyToInput, outputToItem } from '../../src/model/provider-items.ts';

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

const turn = fc.record({
  calls: fc.integer({ min: 0, max: 3 }),
  payload: fc.boolean(),
  text: fc.boolean(),
  // Where history places a tool turn's payload: in completion order (before
  // the turn's output, as agent-core appends it) or after the turn's tool
  // results. A text-only turn has no ids to match on; its stamped payload
  // always leads its message, which is the order the producer emits. With
  // reused ids a trailing payload is indistinguishable from the next turn's
  // leading one, so trailing is only generated with unique ids.
  trailing: fc.boolean(),
});

/** One chat-completions response, as SDK stream chunks. */
function turnFrames(n, t, reuseIds = false) {
  const callId = (c) => (reuseIds ? `call_${c}` : `call_${n}_${c}`);
  const delta = (d) => ({ id: `r${n}`, choices: [{ index: 0, delta: d }] });
  return [
    ...(t.payload
      ? [delta({ reasoning_details: [{ type: 'reasoning.encrypted', data: `SIG_${n}_END`, index: 0 }] })]
      : []),
    ...(t.text || !t.calls ? [delta({ content: `text-${n}` })] : []),
    ...Array.from({ length: t.calls }, (_, c) =>
      delta({
        tool_calls: [{ index: c, id: callId(c), type: 'function', function: { name: 'f', arguments: '{}' } }],
      }),
    ),
    { id: `r${n}`, choices: [{ index: 0, delta: {}, finish_reason: t.calls ? 'tool_calls' : 'stop' }] },
  ];
}

opaqueProperties.push({
  name: 'opaque.turn-attribution',
  property: fc.asyncProperty(
    fc.array(turn, { minLength: 1, maxLength: 30 }),
    // Some providers restart tool call ids in every response.
    fc.boolean(),
    async (turns, reuseIds) => {
      let frames = [];
      let captured;
      const client = {
        chat: {
          completions: {
            create: async (payload) => {
              captured = payload.messages;
              const chunks = frames;
              return (async function* () {
                yield* chunks;
              })();
            },
          },
        },
      };
      const adapter = new OpenAIChatCompletionsModel(client, 'probe', undefined, 'chat-a');
      // History as agent-core keeps it, converted to input by the real bridge.
      const history = [{ type: 'user_message', id: 'u', content: [{ type: 'text', text: 'go' }] }];
      const replay = async () => {
        let output;
        for await (const event of adapter.stream({ input: historyToInput(history, 'chat-a'), tools: [] })) {
          if (event.type === 'completion') output = event.output;
        }
        return output;
      };
      for (const [n, t] of turns.entries()) {
        frames = turnFrames(n, t, reuseIds);
        // Run the real producer: the payload under test is the one it emits.
        const items = (await replay()).map((output) => outputToItem(output, 'chat-a'));
        const results = items
          .filter((item) => item.type === 'tool_call')
          .map((call) => ({ type: 'tool_result', id: `result_${call.callId}`, callId: call.callId, output: `r` }));
        const opaque = items.filter((item) => item.type === 'provider_opaque');
        if (t.trailing && t.calls && !reuseIds)
          history.push(...items.filter((item) => item.type !== 'provider_opaque'), ...results, ...opaque);
        else history.push(...items, ...results);
        // A step without tool calls ends the run; the next step answers a user.
        if (!t.calls) history.push({ type: 'user_message', id: `u${n}`, content: [{ type: 'text', text: 'next' }] });
      }
      frames = turnFrames('final', { calls: 0, payload: false, text: true });
      await replay();
      const json = JSON.stringify(captured);
      assert.ok(!json.includes('term2_turn_tool_call_ids'), 'turn stamp reached the wire');
      // Each turn replays as exactly one assistant message, in turn order, holding
      // exactly its own calls and only its own payload, followed by its results.
      const assistants = captured.filter((message) => message.role === 'assistant');
      assert.equal(assistants.length, turns.length, 'turns were merged or split');
      turns.forEach((t, n) => {
        const ids = Array.from({ length: t.calls }, (_, c) => (reuseIds ? `call_${c}` : `call_${n}_${c}`));
        const message = assistants[n];
        assert.deepEqual(
          (message.tool_calls ?? []).map((call) => call.id),
          ids,
          `turn ${n} gained or lost tool calls`,
        );
        if (t.text || !t.calls)
          assert.ok(JSON.stringify(message.content).includes(`text-${n}"`), `turn ${n} lost its text`);
        const at = captured.indexOf(message);
        assert.deepEqual(
          captured.slice(at + 1, at + 1 + ids.length).map((next) => next.role === 'tool' && next.tool_call_id),
          ids,
          `turn ${n} results do not follow it`,
        );
        const signature = message.reasoning_details?.map((detail) => detail.data);
        assert.deepEqual(signature, t.payload ? [`SIG_${n}_END`] : undefined, `turn ${n} payload misattributed`);
        if (t.payload) assert.equal(json.split(`SIG_${n}_END`).length - 1, 1, `turn ${n} payload duplicated`);
      });
    },
  ),
});
