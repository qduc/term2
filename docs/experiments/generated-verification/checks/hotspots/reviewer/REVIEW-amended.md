# Recheck of 8d789a2c vs reviewed 65de0f5d (Opus 5.5 reviewer)

Verdict: ACCEPT for exact 8d789a2c (HEAD 8d789a2c6acf25818751cb5d8a3bbcd343579aa2; scripts/source match the commit).

The diff is limited to journal.mjs, the README and HOTSPOTS-PLAN.md. No source, package or lock changes.

F1 resolved. The generator emits reasoning-only turns with origin 'stranded' and fresh monotonic turn IDs,
then calls in a later turn. J2 now fails at journal.mjs:93 (reasoning count 1 !== 0).
Shrunk counterexample: a single stranded turn followed by a started call.
Installed-command red, replay and restored-green: exit 1 / 1 / 0 (amended-J2-*.json).
Valid alternates still pass: J5 deep-clone arguments, J6 retire other turns' pending reasoning on new turn.
Wrong behaviour fails: J1, J3, J4, J7 (drop own-turn reasoning), J8 (stranded turn emits an entry).
Mutant results: mutants-journal-amended-500-20261025.jsonl.

F2 resolved. The README and property comment now promise fresh top-level history records only and say
nested JSON may alias. This matches observed production behaviour and doesn't bless or change it.

Fresh seeds on 8d789a2c:
- journal 1730000002 and -88: 1000/1000 each, green
- full run, seed 1730000003, --runs 500: 10 properties x 500, green

Remaining limits:
- interleaved live turns are no longer generated (scoped as unsupported)
- seq is unverified
- nested payload aliasing is a possible owner question, not a contract
- full tiers are the parent's job
