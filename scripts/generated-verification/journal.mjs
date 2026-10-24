import assert from 'node:assert/strict';
import fc from 'fast-check';
import { buildToolLedgerFromJournalEvents } from '../../source/services/conversation/journal-to-ledger.ts';
import { normalizeRunItems } from '../../source/services/conversation/run-item-normalizer.ts';

const unit = fc.record({
  newTurn: fc.boolean(),
  danglingReasoning: fc.option(fc.string(), { nil: null }),
  arguments: fc.jsonValue(),
  output: fc.jsonValue(),
  reasoning: fc.option(fc.string(), { nil: null }),
  status: fc.constantFrom('started', 'completed', 'failed', 'aborted', 'unknown'),
});
export const journalProperties = [
  {
    name: 'journal.reconstruction',
    property: fc.property(fc.array(unit, { maxLength: 30 }), (units) => {
      const seqs = new Map();
      const counts = new Map();
      const events = [];
      const expected = new Map();
      let turnNumber = 0;
      for (const u of units) {
        if (u.newTurn) turnNumber++;
        if (u.danglingReasoning !== null) {
          // A completed/aborted reasoning-only turn must not donate its pending
          // reasoning to the next turn's call. No interleaved live turns needed.
          events.push({
            type: 'assistant_journal_item',
            turnId: `turn-${++turnNumber}`,
            seq: 1,
            item: { type: 'reasoning', text: u.danglingReasoning, providerMetadata: { origin: 'stranded' } },
          });
          turnNumber++;
        }
        const turnId = `turn-${turnNumber}`;
        const callId = `call-${counts.get(turnId) ?? 0}`; // deliberately reused across turns
        counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
        const push = (item) => {
          const seq = (seqs.get(turnId) ?? 0) + 1;
          seqs.set(turnId, seq);
          events.push({ type: 'assistant_journal_item', turnId, seq, item });
        };
        if (u.reasoning !== null)
          push({
            type: 'reasoning',
            text: u.reasoning,
            providerMetadata: { reasoning_content: 'duplicate-private-text', origin: turnId },
          });
        push({ type: 'tool_call', callId, toolName: 'probe', arguments: u.arguments });
        if (u.status !== 'started')
          push({ type: 'tool_result', callId, toolName: 'probe', status: u.status, output: u.output });
        const list = expected.get(turnId) ?? [];
        list.push({ ...u, turnId, callId });
        expected.set(turnId, list);
      }
      const before = structuredClone(events);
      const startedAt = '2026-01-01T00:00:00.000Z';
      const ledger = buildToolLedgerFromJournalEvents(events, startedAt);
      assert.deepEqual(events, before, 'reconstruction mutated journal');
      assert.deepEqual(buildToolLedgerFromJournalEvents(events, startedAt), ledger, 'reconstruction not repeatable');
      const ordered = [...expected.values()].flat();
      assert.equal(ledger.length, units.length, 'lost or merged event identity');
      const identities = new Set();
      ledger.forEach((entry, n) => {
        const e = ordered[n];
        const identity = `${entry.turnId}/${entry.callId}`;
        assert.ok(!identities.has(identity), 'duplicate (turn,call) identity');
        identities.add(identity);
        assert.equal(entry.turnId, e.turnId);
        assert.equal(entry.callId, e.callId);
        assert.equal(entry.toolName, 'probe');
        assert.deepEqual(entry.arguments, e.arguments);
        assert.equal(entry.status, e.status);
        assert.equal(entry.startedAt, startedAt);
        if (e.status !== 'started') {
          assert.deepEqual(entry.output, e.output);
          assert.equal(entry.completedAt, startedAt);
        } else {
          assert.equal(entry.output, undefined);
          assert.equal(entry.completedAt, undefined);
        }
        const normalized = normalizeRunItems(entry.historyItems);
        assert.deepEqual(
          normalized.filter((i) => i.type === 'tool_call').map((i) => i.callId),
          [e.callId],
        );
        assert.deepEqual(
          normalized.filter((i) => i.type === 'tool_result').map((i) => i.callId),
          e.status === 'started' ? [] : [e.callId],
        );
        const reasoning = entry.historyItems.filter((i) => i.type === 'reasoning');
        assert.equal(reasoning.length, e.reasoning === null ? 0 : 1);
        if (e.reasoning !== null) {
          assert.deepEqual(reasoning[0].content, e.reasoning ? [{ type: 'reasoning_text', text: e.reasoning }] : []);
          assert.deepEqual(reasoning[0].providerData, { origin: e.turnId });
        }
      });
      // Returned top-level history records are fresh. Nested arguments/output may
      // alias the event payload; there is no deep-snapshot contract here.
      for (const entry of ledger) if (entry.historyItems?.[0]) entry.historyItems[0].probeMutation = true;
      assert.deepEqual(events, before, 'top-level history record aliases an event item');
    }),
  },
];
