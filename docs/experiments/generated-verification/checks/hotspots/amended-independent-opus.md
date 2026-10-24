# Recheck of `8d789a2c` (against reviewed `65de0f5d`): **ACCEPT**

Both journal fixes hold. The J2 mutant that survived last time now fails on the right assert, correct own-turn reasoning is still accepted, and stranded reasoning that leaks into a later turn is caught.

## What changed
- HEAD is `8d789a2c6acf25818751cb5d8a3bbcd343579aa2`.
- `git diff 65de0f5d 8d789a2c` touches only `scripts/generated-verification/journal.mjs`, the README and `HOTSPOTS-PLAN.md`. No source, package or lockfile changes.
- `git diff 8d789a2c -- scripts source` is empty, so the code I ran is exactly the commit.

**F1 (reasoning leaking across turns): resolved.**
- **Generator:** turn IDs now only move forward, driven by a `newTurn` flag. A `danglingReasoning` unit adds a reasoning-only turn (`origin: 'stranded'`) whose own ID it consumes, so the next call always lands in a later turn.
- **Oracle:** that stranded turn has no expected ledger entry, and any leaked stranded reasoning breaks the reasoning-count or `providerData.origin` check.

**F2 (snapshot claim): resolved.**
- The README and the property comment now promise only fresh top-level history records, and say nested JSON may alias.
- That matches what production does. It doesn't approve or change that behaviour.

## Commands and results
**Journal mutants:** `node reviewer/run-mutants.mjs 500 20261025 mutants-journal-amended.json`. All 9 came out as expected:

| Mutant | Expected | Result |
|---|---|---|
| J0 baseline | pass | 500/500 pass |
| J1 call lookup across turns | fail | fail: "lost or merged event identity" |
| **J2 reasoning shared across turns** | fail | **fail** (survived 300/300 on `65de0f5d`) |
| J3 reasoning metadata not cloned | fail | fail: "reconstruction mutated journal" |
| J4 call history aliases the event item | fail | fail |
| J5 deep-clone arguments (valid alternate) | pass | 500/500 pass |
| J6 retire other turns' pending reasoning on a new turn (valid alternate) | pass | 500/500 pass |
| J7 drop own-turn reasoning | fail | fail |
| J8 stranded turn emits a ledger entry | fail | fail: identity count |

J6 passing shows correct own-turn reasoning isn't falsely rejected.

**J2 through the installed command** (mutant injected in memory via `NODE_OPTIONS`):
- `pnpm -s verify:generated --target journal --seed 31337` went red (exit 1) at `journal.mjs:93`, the reasoning-count assert, with `1 !== 0`.
- It shrank 8 times to path `0:1:0:0:0:2:1:1:1`. The counterexample is a single stranded `""` reasoning turn followed by a started call, which is exactly the leak.
- The emitted replay with the mutant fails again (exit 1). The same replay without the mutant is green (exit 0).

**Fresh seeds on `8d789a2c`:**
- `--target journal --seed=1730000002` and `--seed=-88`: 1,000/1,000 cases each, green.
- Full run, `--seed 1730000003 --runs 500`: all 10 properties × 500 cases, green.
- Reports show `dirty: true` only because of my untracked evidence files and `docs/test-results.json`, which the parent modified. I didn't touch it.

About 8.6k generated cases in total, well within the bound.

## Remaining limits
- Interleaved live turns are no longer generated; you scoped them as unsupported.
- `seq` is still not verified.
- Nested payload aliasing remains a possible question for the owner, not a contract.
- Your final tiers are still pending; I didn't run full tiers, lint or build, and made no network calls.

No permission denials occurred, and session cost isn't available to me. The only files I added are under `reviewer/`:
- REVIEW-amended.md
- mutants-journal-amended.json
- mutants-journal-amended-500-20261025.jsonl
- amended-J2-red.json
- amended-J2-replay.json
- amended-J2-restored.json
- amended-journal-1730000002.json
- amended-journal--88.json
- amended-full-1730000003-r500.json

I also edited my own `run-mutants.mjs` to take an optional mutant-list argument.
