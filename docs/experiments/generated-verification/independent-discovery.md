**Accept the queue defect. Accept the method as useful for the permanent LLM-free checker; final acceptance remains pending.**

I made no edits, package changes, or external provider calls.

**Independent reproduction**

Final checks used commit `0f40efc8a475487874488312640b8c252cd13550`, Node `v24.19.0`, fast-check `4.10.2`. The production queue and adapter are unchanged from base `6075a3cf`.

Invoking the shipped properties directly with seed `424242` produced:

| Property | Result |
|---|---|
| `history.pair-projection` | Passed 1,000 cases; 382 ms |
| `queue.serial-actions` | Failed on case 314; 22 shrinks; 52 ms |

The minimized sequence and replay path exactly matched `discovery.json`:

```text
submit → submit → fail active → remove last queued item
```

I separately exercised `QueueController` without the reference model:

| Action | Observed result |
|---|---|
| Fail active turn with one waiting item | `paused`, one item |
| Remove that waiting item | Accepted; `paused`, empty queue |
| Submit fresh input | Accepted; remains queued; driver does not start |
| Explicitly resume | Fresh input starts |

**The next submission is blocked from execution**, although admission succeeds.

For a read-only reproduction of the shipped property:

```sh
TSX_DISABLE_CACHE=1 node --import tsx --input-type=module -e 'import fc from "fast-check"; import {queueProperties} from "./scripts/generated-verification/queue.mjs"; const r=await fc.check(queueProperties[0].property,{seed:424242,numRuns:1000}); console.log(r);'
```

This wrapper reports `failed: true`; it does not reproduce the runner’s nonzero-exit handling.

**Supported-contract reasoning**

The finding follows supported public operations:

- `ConversationAdapter.retractSubmission` calls `remove_queued`, settles the removed submission, and publishes queue state.
- `remove_queued` removes the item but never clears an empty paused state.
- Failure handling explicitly describes pausing **retained work**, returning idle when nothing remains. `discard_queue` also clears an empty pause.
- The adapter forwards `paused` unchanged. The UI reducer derives `queuePaused` from it, and input ownership selects the pause prompt without checking queue length.

The controller/API defect is demonstrated. I did **not** demonstrate a complete keyboard journey that removes an item after the failure prompt takes ownership. The gateway also enables `discardOnFailure`, so this failure-retention sequence does not apply uniformly to every caller.

**Oracle qualifications**

The specific expectation—removing all retained work releases the pause—is supported. However, the README overstates its backing:

- C12.4 concerns **recovery**, rather than explicitly specifying every in-process removal.
- `#restore` normalizes an interrupted active record with no queued work, but its saved-`pause` branch preserves a pause unconditionally. It does not universally enforce the claimed empty-pause invariant.

Neither qualification invalidates the reproduced removal defect.

**Concrete checker defects and gaps**

1. **Execution IDs can repeat.** [queue.mjs:32](/home/qduc/term2/.worktrees/generated-verification/scripts/generated-verification/queue.mjs:32) derives execution IDs from the submission counter. I reproduced three dispatches with IDs `execution-1`, `execution-3`, `execution-3`. Replaying the previous execution’s completion then incorrectly completed the current turn under this fixture. The checker should generate distinct execution identities.

2. **Its stale-completion coverage is weaker than advertised.** The generated stale action uses only `never-issued`; it never replays an actual previous execution ID. Combined with the fixture defect above, this misses an important identity boundary.

3. **Dispatch payload verification is incomplete.** The driver records only item IDs. State assertions check item text, but never the dispatched snapshot’s text. Incorrect snapshot contents could therefore escape this property.

4. **The documented command cannot run in this sandbox.** pnpm failed with `EROFS` creating a temporary file. Direct runner execution failed with `spawnSync git EPERM`. Direct property execution succeeded. These are observed portability limitations, not evidence that the runner fails in an ordinary writable environment.

The pilot demonstrated useful discovery: a real production defect, a four-action counterexample, deterministic shrinking, and inexpensive execution without an LLM. It has not yet demonstrated a completed, accepted permanent checker: the confirmed product defect remains unresolved, the identity fixture needs correction, and installed-command verification remains pending. No verification ledger was written because this assignment explicitly prohibited edits.