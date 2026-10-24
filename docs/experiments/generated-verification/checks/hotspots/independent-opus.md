# Independent review of `65de0f5d` against `89141139`: **REJECT**

The rejection is narrow. Both must-fix findings are in `journal.reconstruction`: one claimed behaviour is never exercised, and one oracle check passes on behaviour that doesn't hold. Compaction, continuity and opaque meet the bar and I'd accept them as they stand. The runner integration is also fine.

## Must-fix findings

**F1: "no cross-turn reasoning leakage" is never exercised (`scripts/generated-verification/journal.mjs`).**
- **Why it can't fail:** the generator always pushes a unit's reasoning immediately before the same turn's `tool_call`. That call clears pending reasoning before any other turn's event arrives, so reasoning never has a chance to cross turns.
- **Mutant that survived:** J2 keys the pending-reasoning buffer globally (`"*"`) instead of per turn. It passed 300/300 at seed 20261024.
- **Reproduction:** `reviewer/journal-gap-probe.mjs` builds a sequential shape the generator never emits: turn-0 ends with reasoning and no call, then turn-1 makes a call.
  - On unmodified production, turn-1 gets **0** reasoning items.
  - Under the J2 mutant it gets **1**, so the leak happens and the property can't see it.
- **Suggested fix:** let units sometimes emit reasoning with no call, or put other-turn events between a reasoning item and its call. Production keeps pending reasoning per turn, so the oracle stays simple: reasoning attaches only to its own turn's next call and never to another turn.

**F2: the "snapshot history isolation" claim is false below the top level.**
- **Why the check passes:** it sets a top-level `probeMutation` key on `historyItems[0]`. That object is always freshly built, so the check can't detect aliasing of anything nested inside it.
- **Reproduction (same probe, unmodified production):** mutating `.arguments.nested.v` and `.output.nested.v` on the returned history items changes the journal events themselves (`{nested:{v:99}}`, `{nested:{v:98}}`). Nested arguments and outputs are shared with the events, not copied.
- **Suggested fix:** narrow the README and the property comment to "top-level history items are fresh objects". Alternatively, deepen the check and refer the resulting production aliasing to the owner. Production must not change under this task.

## Non-blocking observations
- The journal oracle requires entries grouped by each turn's first appearance. That matches production, but it would reject a reconstruction that uses plain global event order, and only on interleaved-turn inputs. Real journals may never contain those.
- `seq` is generated but production ignores it, so nothing about sequence numbers is verified.
- Continuity's "anchor not revived" assert after `observeCandidate` can't fail, because that method never touches `previousResponseId`. The real discriminator is the `false` return value, which K3/K4 confirm works.

## Discriminating probes (in-memory mutants, no source edits)
I mutated modules in memory using a Node sync load hook (`reviewer/mutant-hook.mjs`). It rewrites the tsx-transformed source text, and it throws if an edit string isn't found, so a mutant can't silently fail to apply. 36 of 37 mutants behaved as expected; J2 is the exception.

| Area | Wrong behaviour, correctly failed | Valid alternate, correctly passed |
|---|---|---|
| Compaction | cut mid parallel round · drop protected users · protect synthetic users · mutate input · always blocked · duplicated hot-tail user · accept duplicate call · accept orphan result | latest settled-round cut · earliest settled-round cut |
| Continuity | no debt dedupe · new turn keeps debt · reset keeps lineage · candidate ignores lineage · `breakChaining` keeps debt · filter reorders by debt · no orphan check · no missing-output error | `breakChaining` also bumps lineage |
| Journal | call lookup across turns · reasoning metadata not cloned · call history aliases the event item · **J2 survived (F1)** | deep-clone arguments |
| Opaque | Responses lane filter removed · origin pin removed · Chat accepts any tag · Responses accepts legacy tag · Chat drops own payload · Responses rewrites own payload · Codex pins to `openai` origin | Grok rejecting the legacy tag passes too, so that policy is genuinely excluded, not decided |

Baselines (unmutated) passed for all five new properties.

## Commands and results
- **Full fresh seed:** `pnpm -s verify:generated --seed 1730000001 --output reviewer/full-1730000001.json` exited 0. All 10 properties ran 1,000 cases each with 0 failures and 0 skips, in about 3.8 s. The report shows `dirty: true` because of untracked evidence plus two tracked docs the parent edited concurrently (`HOTSPOTS-PLAN.md`, `docs/test-results.json`); I didn't touch either. I confirmed `git diff 65de0f5d -- scripts source package.json pnpm-lock.yaml` is empty.
- **No production or dependency changes:** `git diff 89141139 65de0f5d -- source package.json pnpm-lock.yaml` is empty.
- **Per target:** `--target compaction|continuity|journal|opaque --seed 424 --runs 200` all passed. `--property journal.reconstruction --seed 9 --runs 500` passed.
- **Error handling:**
  - `--target journal --property opaque.lane-isolation` gives `Error: unknown property for target`.
  - `--target nope` gives `Error: unknown target`.
- **Output refusal:** `--output` pointed at an existing file exited 2 with `EEXIST`, and `cmp` showed the file unchanged.
- **Red / replay / restored green through the installed command** (mutant injected via `NODE_OPTIONS`):
  - Compaction mutant C1, seed 555: red exit 1 with "cut split a pending round" after 8 shrinks, path `3:0:0:0:1:1:1:1:1`. The minimal counterexample is one turn with two parallel calls and a budget of 100. Replaying the emitted command still fails (exit 1, 1 case). Without the mutant, the same replay is green (exit 0).
  - Opaque mutant O2 (async path), seed 777: red exit 1. Shrunk counterexample: `[{lane:"openai",origin:"grok"}]` sent to `openai`. Replay exit 1; restored exit 0.
- **Volume:** about 14.6k generated cases in total, roughly 10 minutes wall time.

## Limitations
- I didn't run the full tiers, lint, type-check or build; those belong to the parent.
- No production source faults were injected; all mutants were in-memory only.
- No network or provider calls were made.
- I didn't read the retained `independent-opus.*` artifacts, so this review stays independent of them.

No permission denials occurred. Session cost isn't available to me.

Files are in `docs/experiments/generated-verification/checks/hotspots/reviewer/`:
- REVIEW.md
- mutants-300-20261024.jsonl
- journal-gap-probe.mjs
- full-1730000001.json
- mutant-hook.mjs
