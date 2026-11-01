import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { createLog, openLog, readFactLines } from '../../rewrite/src/session/log.ts';
import { captureDirectFinalWindow, recoverDirectFinalWindow } from '../../rewrite/src/session/direct-final.ts';
import { adoptedModelConversion } from '../../rewrite/src/model/adopted/index.ts';

// Decode embedded provider JSON once, while also inspecting literal ref framing.
function storedStrings(value, out = []) {
  if (typeof value === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      /* ordinary text */
    }
    if (parsed !== null && typeof parsed === 'object') storedStrings(parsed, out);
    else out.push(value);
  } else if (value !== null && typeof value === 'object')
    Object.values(value).forEach((child) => storedStrings(child, out));
  return out;
}

const unit = fc.record({
  body: fc.string({ minLength: 1, maxLength: 40 }),
  size: fc.integer({ min: 200, max: 3000 }),
  structured: fc.boolean(),
  promptEcho: fc.boolean(),
  display: fc.constantFrom('same', 'framed', 'different'),
  reopen: fc.boolean(),
  rotate: fc.boolean(),
});

export const nativeLogProperties = [
  {
    name: 'native-log.single-source',
    property: fc.property(fc.array(unit, { minLength: 1, maxLength: 6 }), (units) => {
      const directory = mkdtempSync(join(tmpdir(), 'term2-native-property-'));
      let writer = createLog(directory, 'root');
      const paths = [writer.path];
      let expected = [];
      let prefix = [];
      let afterSeq = 0;
      const accept = (facts) => {
        writer.append(facts);
        expected.push(...structuredClone(facts));
      };
      try {
        const sentinels = [];
        for (const [n, u] of units.entries()) {
          const turnId = `turn-${n}`,
            executionId = `execution-${n}`,
            callId = `call-${n}`;
          // Identity-specific, long markers avoid mistaking genuine equal output
          // from separate executions for redundant storage. Include JSON escapes.
          const body = `BEGIN_PAYLOAD_${n}_` + u.body.repeat(Math.ceil(u.size / u.body.length)) + `_END_PAYLOAD_${n}`;
          const argumentUnit = u.body + '\n"\\🙂';
          const argument =
            `BEGIN_ARGUMENT_${n}_` + argumentUnit.repeat(Math.ceil(u.size / argumentUnit.length)) + '_END';
          sentinels.push(body, argument);
          const input = { code: argument };
          const call = adoptedModelConversion.inputToItem(
            { type: 'tool_call', id: callId, name: 'probe', arguments: JSON.stringify(input) },
            'mock',
          );
          const sourceOutput = u.structured
            ? [{ type: 'text', text: body + '\n"\\\ud83d\ude42' }]
            : `model prefix\n${body}`;
          const output = typeof sourceOutput === 'string' ? sourceOutput : JSON.stringify(sourceOutput);
          const displayOutput =
            u.display === 'same'
              ? output
              : u.display === 'framed'
              ? `display prefix\n${body}`
              : `DISTINCT_DISPLAY_${n}_` + 'd'.repeat(u.size);
          accept([
            {
              type: 'turn_started',
              turnId,
              input: [
                {
                  type: 'user_message',
                  id: `user-${n}`,
                  content: [{ type: 'text', text: u.promptEcho ? argument : 'probe' }],
                },
              ],
            },
            { type: 'item', turnId, executionId, item: call },
            { type: 'tool_started', turnId, executionId, callId, toolName: 'probe', input },
            {
              type: 'item',
              turnId,
              item: {
                type: 'reasoning',
                id: `reasoning-${n}`,
                summary: argument,
                providerMetadata: { signature: argument },
              },
            },
            {
              type: 'item',
              turnId,
              item: { type: 'provider_opaque', id: `opaque-${n}`, provider: 'mock', item: { encrypted: argument } },
            },
            {
              type: 'tool_finished',
              turnId,
              executionId,
              result: {
                output,
                isError: false,
                display: [
                  {
                    id: `display-${n}`,
                    sender: 'command',
                    status: 'completed',
                    command: 'probe',
                    toolName: 'probe',
                    output: displayOutput,
                  },
                ],
              },
            },
          ]);
          // Result-first crash boundary: no later item is needed to restore output.
          assert.deepEqual(
            readFactLines(writer.path, { afterSeq, prefix }).map((line) => line.fact),
            expected.slice(prefix.length),
          );
          if (u.reopen) {
            const file = writer.path;
            writer.close();
            writer = openLog(file, { afterSeq, prefix });
          }
          if (u.rotate) {
            prefix.push(...readFactLines(writer.path, { afterSeq, prefix }));
            afterSeq = prefix.at(-1).seq;
            writer.close();
            writer = createLog(directory, `segment-${n}`, { afterSeq, prefix });
            paths.push(writer.path);
          }
          const item = u.structured
            ? adoptedModelConversion.inputToItem({ type: 'tool_result', id: callId, output: sourceOutput }, 'mock')
            : { type: 'tool_result', id: `result-${n}`, callId, output, isError: false };
          assert.equal(item.type, u.structured ? 'provider_input' : 'tool_result');
          accept([{ type: 'item', turnId, ...(u.structured ? {} : { executionId }), item }]);
          // Approved full-history exception must not erase accepted public evidence.
          accept([{ type: 'history_replaced', turnId, reason: 'rewind', history: [] }]);
          const ended = { type: 'turn_ended', turnId, outcome: 'completed' };
          const projected = captureDirectFinalWindow(expected, ended);
          assert.equal(projected.record.commandMessages[0]?.output, displayOutput, 'visible display lost');
          accept([ended]);
          const all = [...prefix, ...readFactLines(writer.path, { afterSeq, prefix })].map((line) => line.fact);
          assert.deepEqual(all, expected, 'hydrated facts changed');
          assert.deepEqual(recoverDirectFinalWindow(all.slice(0, -1), ended), projected, 'terminal cut changed');
          assert.equal(projected.derivedFromAcceptedFacts, undefined, 'current format mislabeled legacy');
        }
        writer.close();
        const raw = paths.map((file) => readFileSync(file, 'utf8')).join('');
        const physical = raw
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const strings = physical.flatMap((line) => storedStrings(line));
        for (const body of sentinels)
          assert.equal(
            strings.filter((value) => value.includes(body)).length,
            1,
            'large payload persisted more than once',
          );
        // Inspect every large semantic leaf in the generated facts, not only
        // named tool sentinels. Deltas/history snapshots are approved exceptions.
        for (const turnId of units.map((_, n) => `turn-${n}`)) {
          const eligible = (fact) => fact.turnId === turnId && !['text_delta', 'history_replaced'].includes(fact.type);
          const actual = physical.filter((line) => eligible(line.fact)).flatMap((line) => storedStrings(line));
          const large = new Set(
            expected
              .filter(eligible)
              .flatMap((fact) => storedStrings(fact))
              .filter((text) => text.length >= 200),
          );
          for (const text of large)
            assert(
              actual.filter((value) => value.includes(text)).length <= 1,
              'same-turn large string repeated in physical facts',
            );
        }
        assert(!raw.includes('finalWindow'), 'derived terminal window persisted');
        // A syntactically valid, unterminated line remains torn, including refs.
        const last = paths.at(-1);
        appendFileSync(last, '{"v":2,"seq":999,"fact":{}}');
        assert.deepEqual(
          readFactLines(last, { afterSeq, prefix }).map((line) => line.fact),
          expected.slice(prefix.length),
        );
      } finally {
        writer.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  },
];
