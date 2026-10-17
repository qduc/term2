# Independent v2 ownership review

Reviewed by fresh independent verifier `/root/design_verify`, 2026-10-17.
No implementation verdict was supplied. Scope: standalone fake ports and proposed
ownership design, not real adapter stop proof or production readiness.
Baseline HEAD: `5e2fe139a9a658f31a4a94939806c0de8d0d7eb0`.

**Initial verdict: reject the original executable revision pending the demonstrated outcome-loss fix below.**
The ownership direction remains a reasonable bounded experiment. This verdict does
not reject conversation-owned scheduling or require a different architecture.

## Final focused recheck — accept within prototype scope

**Final verdict: accept** the revised standalone ownership prototype at the hashes
below. No concrete unresolved must-fix failure remains from this review. This is
not acceptance of production migration, adapter stop proof, architecture parity,
or a demonstrated human comprehension improvement.

Triage routed the original silent-loss defect to a narrow correction: `#finish`
consults the current execution's existing known result when settling the first
unfinished call. `#acceptFact` now includes the copied result fact in its event.
This adds no stored state, controller, timer, or recovery mode. The current stop
barrier and stale transcript exclusion remain intact. The original failure and
original hashes/source remain below as historical evidence, not a claim that the
revised code still fails.

Rechecked the modified source and clarified short model: foreground advancement
needs result and stop, retired foreground/session work blocks admission, ordinary
background work does not, and pre-revocation knowledge survives cancellation.
Those statements match the scoped implementation and explicit omissions.

Exact commands rerun after the fix:

```sh
pnpm exec tsx experiments/conversation-actor/v2/tmp-independent-recheck.ts
pnpm exec tsx experiments/conversation-actor/v2/simulate.ts --all
pnpm exec tsc -p experiments/conversation-actor/v2/tsconfig.json
```

All exited 0. Current harness: **26/26 PASS**. Standalone typecheck: no diagnostics.
Independent recheck: original sequence now gives:

```json
[{"role":"tool","id":"write","outcome":"wrote row 42"},{"role":"tool","id":"read","outcome":"not-executed"}]
```

The registry's known fact value is also present in the copied execution-result
journal event. Replacement still waits for stopped. A duplicate result after
release cannot overwrite the transcript. Additional independent checks PASS:

- Late known results received after cancellation, either before or after stop,
  remain excluded from the cancelled turn's transcript; outcome stays unknown.
- The 24 result/stop/cancel/submit permutations now assert both no replacement
  before stop and known outcome iff result preceded revocation.
- Synchronous stop-first ports and reentrant observer submission complete exactly
  two turns with no leftover execution records.

Final reviewed SHA-256:

```text
148467aa48d578dda41cece6f058670fd4475b8c910fdedea7ee292ff961cc46  experiments/conversation-actor/v2/actor.ts
37942bb43ece352442b644753680cff3efbb211b6312bd1f57cbc227967b4d90  experiments/conversation-actor/v2/simulate.ts
01917f55f81967ff36b3c096acce9b3db9bb01dec60e47743d1f298d82331e47  experiments/conversation-actor/v2/DESIGN.md
f5debc170bdb376af2bf66325241085582a2829fa3e34c5b59b304af873ba596  docs/design/conversation-core.md
```

Recheck probe SHA-256: `3196ddeef2b20a9cb4ec63a18d51ce0353dcc4791255fc349b9fd15c087af957`.
Temporary probe removed after execution; complete source retained here:

```ts
import assert from 'node:assert/strict';
import { Simulation } from './simulate.js';
import { Conversation, type Fact } from './actor.js';

// Already observed knowledge must survive revocation; physical stop gates admission independently.
const s = new Simulation();
s.submit();
await s.flush();
await s.reply(0, [{ id: 'write', name: 'write' }, { id: 'read', name: 'read' }]);
s.tools[0].autoStop = false;
await s.known(0, 'wrote row 42');
assert.equal(s.actor.snapshot().executions[0].hasResult, true);
s.actor.send({ type: 'cancel', turn: s.actor.snapshot().turn!.id });
s.submit('b');
assert.equal(s.models.length, 1);
s.tools[0].report({ kind: 'stopped' });
await s.flush();
const outcomes = s.models[1].request.history.filter(x => x.role === 'tool');
console.log(JSON.stringify({ probe: 'known-result-then-cancel-then-stop', outcomes,
  resultJournal: s.events('execution-result'), settledJournal: s.events('tool-settled') }));
assert.deepEqual(outcomes, [
  { role: 'tool', id: 'write', outcome: 'wrote row 42' },
  { role: 'tool', id: 'read', outcome: 'not-executed' },
]);
const accepted = s.events('execution-result').find(e => e.detail.id === '1/write')!;
assert.deepEqual(accepted.detail.fact, {kind:'tool-result',outcome:{kind:'known',value:'wrote row 42'}});
const beforeLate = s.actor.snapshot().history;
s.tools[0].report({kind:'tool-result',outcome:{kind:'known',value:'late overwrite'}});
assert.deepEqual(s.actor.snapshot().history,beforeLate);
await s.reply(1);
s.verify();

for (const lateBeforeStop of [true,false]) {
  const late = new Simulation(); late.submit(); await late.flush();
  await late.reply(0,[{id:'write',name:'write'}]);
  late.tools[0].autoStop=false;
  late.actor.send({type:'cancel',turn:late.actor.snapshot().turn!.id});
  late.submit('b');
  const value={kind:'tool-result',outcome:{kind:'known',value:'post-revocation'}} as const;
  if(lateBeforeStop) late.tools[0].report(value);
  late.tools[0].report({kind:'stopped'});
  if(!lateBeforeStop) late.tools[0].report(value);
  assert.deepEqual(late.models[1].request.history.filter(x=>x.role==='tool'),[{role:'tool',id:'write',outcome:'unknown'}]);
  await late.reply(1); late.verify();
}
console.log(JSON.stringify({probe:'late-result-before-or-after-stop-excluded',result:'PASS'}));

// Entirely synchronous ports exercise report/start reentrancy without promise timing.
let modelCount = 0;
const sync = new Conversation({
  model: (_request, _signal, report) => {
    modelCount++;
    report({ kind: 'stopped' });
    report({ kind: 'model-result', reply: { text: 'done', calls: [] } });
  },
  tool: () => { throw new Error('unexpected'); },
});
sync.observe(event => { if(event.type === 'accepted' && event.detail.id === 'a') sync.send({type:'submit', id:'b',text:'b'}); });
sync.send({type:'submit',id:'a',text:'a'});
assert.equal(modelCount,2);
assert.deepEqual(sync.snapshot().submissions.map(x=>x.status),['completed','completed']);
assert.deepEqual(sync.snapshot().executions,[]);
console.log(JSON.stringify({probe:'synchronous-stop-first-and-reentrant-observer',result:'PASS'}));

// Independent 24-order matrix: outcome, stop, cancel, submit; no replacement before stop.
function permutations<T>(xs:T[]):T[][] { return xs.length ? xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>i!==j)).map(rest=>[x,...rest])) : [[]]; }
for (const order of permutations(['result','stop','cancel','submit'])) {
  const t = new Simulation(); t.submit(); await t.flush();
  await t.reply(0,[{id:'write',name:'write'}]);
  t.tools[0].autoStop=false;
  const turn=t.actor.snapshot().turn!.id;
  let stopped=false;
  for (const step of order) {
    if(step==='result') t.tools[0].report({kind:'tool-result',outcome:{kind:'known',value:'ok'}});
    if(step==='stop') { stopped=true;t.tools[0].report({kind:'stopped'}); }
    if(step==='cancel') t.actor.send({type:'cancel',turn});
    if(step==='submit') t.submit('b');
    assert.ok(stopped || t.models.length===1, `no next model before stop: ${order}`);
  }
  const expected = order.indexOf('result') < order.indexOf('cancel') ? 'ok' : 'unknown';
  assert.deepEqual(t.actor.snapshot().history.filter(x=>x.role==='tool').map(x=>x.outcome),[expected],`outcome ordering: ${order}`);
  for(let i=1;i<t.models.length;i++) await t.reply(i);
  t.verify();
}
console.log(JSON.stringify({probe:'24-result-stop-cancel-submit-orders',result:'PASS'}));```

## Claims and methods (initial revision)

- Single continuation controls foreground advancement: reran all existing scenarios,
  checked phase/token gating, then exercised synchronous stop-first reports and
  reentrant observer submission independently.
- Revocation does not permit physical overlap: reran lifetime scenarios and an
  independent 24-order result/stop/cancel/submit matrix.
- Known effect outcomes survive cancellation: independently probed the missing
  known-result-before-stop cancellation ordering; this claim fails.
- Production deletion map preserves named responsibilities: targeted source inspection
  of queue, adapter, mailbox, status machine, workflow and run loop. This is a
  responsibility-map check, not a migration proof.

## Demonstrated finding — preserve known outcome before revocation

Trigger: model dispatches write then read; write reports known `wrote row 42` but
has not supplied stopped evidence; user cancels; new input queues; write supplies
stopped; replacement model starts. Its history says write `unknown`, read
`not-executed`. The write was already known before cancellation.

Evidence: `Conversation.#acceptFact` (actor.ts:269) stores the known result and
emits `execution-result`; `#finish` (actor.ts:457, debt repair at 463–469) chooses
unknown from phase alone; `#advanceExecution` (288) subsequently deletes the
retired execution. The event stores kind but not the value, so the known value
cannot be reconstructed from the surviving journal either. The probe observed
`hasResult: true` before cancellation and the following replacement request:

```json
[{"role":"tool","id":"write","outcome":"unknown"},{"role":"tool","id":"read","outcome":"not-executed"}]
```

Impact: accepted outcome knowledge is silently lost; the replacement model may
ask to reconcile or repeat a write whose result was already supplied. This is
inside fake-port scope and does not depend on real process semantics. The barrier
itself behaved correctly and withheld replacement until stopped.

Owner: conversation fact acceptance/history settlement. Invariant: revocation
removes advancement authority, but cannot erase known effect evidence received
before revocation. Results arriving after revocation remain stale.

Disposition: **fix**. Simplest change: when paying the current foreground call's
debt, consult its matching execution result; use a pre-revocation known tool
outcome when present, otherwise retain unknown. Keep physical-stop gating
unchanged. Mechanism cost: one lookup/branch, no new stored state, controller,
timer, or recovery mode. Elimination alternative: record effect outcome knowledge
on receipt independently of continuation advancement; that is a wider change and
not necessary for this prototype. Reject any alternative that treats a known
result as stop proof.

## Other attack areas and dispositions

- Correctness: the demonstrated outcome-loss finding above; no second concrete
  wrong-outcome defect established.
- Failure modes: a throwing start is converted to an error/unknown plus stop-unproven;
  without stop evidence admission can remain held. **Accept risk** within the
  expressly scoped experiment: fabricating proof would violate its central rule.
  This is a real production usability obligation, not an adapter capability shown here.
- Hidden assumptions: stopped is trusted per-execution adapter evidence, including
  descendants/effects within its contract. **Document as unsupported** for real
  adapters; the existing design does this clearly. No timeout or extra controller
  is justified by this review.
- Unenforced invariants: callback kind matching rejects wrong model/tool result
  types and first outcome wins. Phase/token validation and copies guard stale
  approvals, replayed completions, observer mutation and synchronous reentrancy in
  the inspected/scenario coverage. No additional concrete defect survived.
- Ownership leaks: the production map correctly preserves pause/recovery/preflight,
  rich payloads, journal/effect repair, provider affinity and shared/nested run-loop
  duties rather than declaring all named modules deletable. **Accept risk** as a
  proposal, contingent on its explicitly pending per-cut production evidence.

## Teachability and complexity judgment

The short model provides useful locations for input ownership, continuation and
execution lifetime. It distinguishes knowledge from stop proof and identifies
journal durability separately. The one-registry revision removes the duplicate
root abort/controller representation without pretending every background or child
contract already fits. However the hard residual contracts (pause policy,
streaming, compaction, child approval, persistence failure and transfer) remain
unimplemented. The map's preservation column is therefore essential; deleting
that detail would hide rather than remove complexity. No claim that this is easier
for a human to understand is established by my review. The independent reader
exercise and actual user feedback are separate evidence.

## Exact executed commands and results

Run in `/home/qduc/term2/.worktrees/conversation-design`:

```sh
pnpm exec tsx experiments/conversation-actor/v2/simulate.ts --all
pnpm exec tsc -p experiments/conversation-actor/v2/tsconfig.json
pnpm exec tsx experiments/conversation-actor/v2/tmp-independent-probe.ts
```

Existing harness: exit 0, 25/25 PASS (including the five new lifetime scenarios).
Standalone tsc: exit 0, no diagnostics.
Independent probe: exit 0; first section asserts the observed defect so that the
bad history is retained as evidence, not mistaken for a passing behavior claim.
Other sections output:

```json
{"probe":"synchronous-stop-first-and-reentrant-observer","result":"PASS"}
{"probe":"24-result-stop-cancel-submit-orders","result":"PASS"}
```

The matrix asserts no next model before the original tool stopped, completes the
remaining turns, and runs the existing history/receipt invariant checker for each
order. It does not validate real adapter quiescence.

Reviewed content hashes (SHA-256):

```text
5a55faea589b3ba49d05a3aa41ea3c3bf84ac65ef720ab6f5755688ca6dac60f  experiments/conversation-actor/v2/actor.ts
1d2c64aff8be53b2523ea44daf704e2297c6229bde10e0e8ae54573fb0153b2c  experiments/conversation-actor/v2/simulate.ts
c2f60443f4ecec51308e4ae302dfed3cf02d064f43a5d073faa3dee7295375fd  experiments/conversation-actor/v2/DESIGN.md
ca028317353ba44143b8489c23dfb95e4e075c4a71577ff7d26631a8b1766965  docs/design/conversation-core.md
```

Temporary independent probe SHA-256: `09b426d6ef6ab660141f90693b7fcb9b2026d5d6de6da3ca2c1e2bc1d9aa1124`.
The temporary file was removed after execution; its complete source is retained
below so this evidence is reproducible. No production code or design was edited
by this verifier. No provider suite was run: this prototype imports no production
runtime or provider adapter; running it would not establish the scoped claims.
Typecheck/lint of the full worktree are owned by the implementer; the standalone
prototype typecheck above was independently rerun.

## Temporary probe source

```ts
import assert from 'node:assert/strict';
import { Simulation } from './simulate.js';
import { Conversation, type Fact } from './actor.js';

// Already observed knowledge must survive revocation; physical stop gates admission independently.
const s = new Simulation();
s.submit();
await s.flush();
await s.reply(0, [{ id: 'write', name: 'write' }, { id: 'read', name: 'read' }]);
s.tools[0].autoStop = false;
await s.known(0, 'wrote row 42');
assert.equal(s.actor.snapshot().executions[0].hasResult, true);
s.actor.send({ type: 'cancel', turn: s.actor.snapshot().turn!.id });
s.submit('b');
assert.equal(s.models.length, 1);
s.tools[0].report({ kind: 'stopped' });
await s.flush();
const outcomes = s.models[1].request.history.filter(x => x.role === 'tool');
console.log(JSON.stringify({ probe: 'known-result-then-cancel-then-stop', outcomes,
  resultJournal: s.events('execution-result'), settledJournal: s.events('tool-settled') }));
assert.deepEqual(outcomes, [
  { role: 'tool', id: 'write', outcome: 'unknown' },
  { role: 'tool', id: 'read', outcome: 'not-executed' },
]);
await s.reply(1);
s.verify();

// Entirely synchronous ports exercise report/start reentrancy without promise timing.
let modelCount = 0;
const sync = new Conversation({
  model: (_request, _signal, report) => {
    modelCount++;
    report({ kind: 'stopped' });
    report({ kind: 'model-result', reply: { text: 'done', calls: [] } });
  },
  tool: () => { throw new Error('unexpected'); },
});
sync.observe(event => { if(event.type === 'accepted' && event.detail.id === 'a') sync.send({type:'submit', id:'b',text:'b'}); });
sync.send({type:'submit',id:'a',text:'a'});
assert.equal(modelCount,2);
assert.deepEqual(sync.snapshot().submissions.map(x=>x.status),['completed','completed']);
assert.deepEqual(sync.snapshot().executions,[]);
console.log(JSON.stringify({probe:'synchronous-stop-first-and-reentrant-observer',result:'PASS'}));

// Independent 24-order matrix: outcome, stop, cancel, submit; no replacement before stop.
function permutations<T>(xs:T[]):T[][] { return xs.length ? xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>i!==j)).map(rest=>[x,...rest])) : [[]]; }
for (const order of permutations(['result','stop','cancel','submit'])) {
  const t = new Simulation(); t.submit(); await t.flush();
  await t.reply(0,[{id:'write',name:'write'}]);
  t.tools[0].autoStop=false;
  const turn=t.actor.snapshot().turn!.id;
  let stopped=false;
  for (const step of order) {
    if(step==='result') t.tools[0].report({kind:'tool-result',outcome:{kind:'known',value:'ok'}});
    if(step==='stop') { stopped=true;t.tools[0].report({kind:'stopped'}); }
    if(step==='cancel') t.actor.send({type:'cancel',turn});
    if(step==='submit') t.submit('b');
    assert.ok(stopped || t.models.length===1, `no next model before stop: ${order}`);
  }
  for(let i=1;i<t.models.length;i++) await t.reply(i);
  t.verify();
}
console.log(JSON.stringify({probe:'24-result-stop-cancel-submit-orders',result:'PASS'}));
```

## Uncertain

Real process/descendant stop evidence, persistence and restart, real provider
serialization/continuity, production rich payload/queue-policy parity, actual
background transfer, streaming/partial output and compaction, human comprehension,
and actual net production state deletion were not established by this review.
