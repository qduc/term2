# Tool occurrence recovery: offline handoff

Author-verified isolated dirty tree at HEAD
`4731459c44584c6e49854dac4a1d50cb849687dd`; **independent verification not performed**.
The parent owns independent inspection and acceptance. No merge or publication.

## Reproduce

From the candidate checkout root:

```sh
node docs/experiments/tool-occurrence-recovery/verify.mjs
```

The entrypoint imports production source from **current cwd**, records its SHA-256
inventory, Git HEAD/status, Node executable/version and loader in `identity.json`,
and prints a fresh evidence directory. It runs foreground children with test-only
120-second deadlines. It defaults to temporary evidence outside the repository.
A missing local tsx loader falls back to the known existing
`/home/qduc/term2/node_modules/tsx/dist/loader.mjs`; the probe-only resolver falls
back for missing bare dependencies, never relative candidate source imports.
`evidence/current/portable.log`, `.exit` and `portable/identity.json` retain a
passing run with this worktree's node_modules temporarily absent (restored in
finally). No production setup changes, credentials, provider network, or paid API.

## Change and contract

Provider call IDs correlate protocol calls/results; they are not execution IDs.
The existing ledger admission owner now assigns optional positive turn-local
per-call ordinals before validation, approval or body dispatch. Canonical items,
journal keys, saved ledger, direct results, replay, history reconciliation,
segment filtering, repair and surge signatures carry `(turnId, callId, occurrence)`.
Provider payloads and call IDs are unchanged. Explicit metadata wins; old ordered
entries receive deterministic ordinals. Projected legacy-only evidence retains
best-effort semantics; missing historical bytes are not invented.

The review's escaped defect was in untagged final-item correlation:
`assistant_turn` knew its authoritative turn but matched against the entire ledger
by equal payload. It could borrow an earlier user's admission. Final matching is
now limited to the authoritative turn **at that caller**. Accumulated-history
alignment callers in ledger reconciliation, replay repair and record-stream
selection remain conversation-wide. Alignment also retains a matched call's
ownership for its result rather than selecting another sibling independently.
An unmatched call keeps its result unmatched, allowing ordered final pairing to
allocate the new turn's ordinal.

`tool-occurrence.ts` supplies the shared identity and ordered authoritative pairing
rule, replacing independent call-ID maps at reconstruction joins. Existing
same-occurrence dedup, envelope event-ID dedup and bounded-growth repair remain.
The generated reconciliation oracle now checks provider payload separately from
application-owned identity and asserts identity is present and valid; its initial
failure/seed/shrink are retained, not discarded.

## Evidence and coverage

All paths below are under `evidence/current/`.

- `original-red.log` / `.exit`: mandatory retained `probes/run.sh preservation`
  rerun against `/home/qduc/term2` **before source edits**, exit 1, named assertion
  `full occurrence preservation: reused-cut` (1 != 2). `original-red-native/`
  retains the native JSONLs, flushed prefix and replay. No import/setup failure.
- `legacy-red.log` / `.exit`: restored candidate before the targeted correction,
  equal-output untagged two-turn case, exit 1 (`actual next request two calls`).
  `legacy-different-red.log` / `.exit`: different-output case against the retained
  reviewed candidate, exit 1. `red-source-provenance.json` inventories original
  and retained reviewed source read-only **after** those executions; it is not
  claimed as a pre-execution inventory. Candidate provenance is the retained
  review `evidence/actual.patch` from task `53a8516cff344a46a26f5f8605270eb7`.
- `retained-green.log` / `.exit`: exact inherited preservation runner against cwd,
  exit 0; `retained-green-native/` and `pairing-green.log` / `.exit` retain all
  four scenarios and stronger argument/output ownership checks (exit 0).
- `portable/`: complete green source/runtime identity, native prefixes, replay,
  observations, and all five entrypoint subprocess logs/exits. The eight runtime
  scenarios cover distinct/reused/byte-identical calls and three reused IDs over
  two rounds, each with pre-final cut and normal final. Six occurrences survive
  replay and reach the actual next fake-model request without surge confirmation.
- `portable/legacy-{equal,different}.log` and `tagged-{equal,different}.log`:
  valid decoded two-user-turn finals, same ID/arguments, equal or different
  outputs, tagged or untagged. A fresh runtime imports actual replay state and
  captures its real next model request: two ordered calls/results with their own
  outputs and turn-local ordinal 1. No fixture-side history reconstruction.
- `portable/controls-*/observations.json`: strict invalid, denied and approved
  same-ID occurrences (one body), stale/copied approval rejection, unknown tool,
  admitted-before-result interruption, exact later-segment direct result,
  same-occurrence wrapper/canonical dedup, accumulated history without growth,
  fulfilled parallel sibling preservation before real HarnessInvariantError,
  ordinary Error result, legacy logs/snapshots, duplicate envelopes, rich final,
  explicit and untagged final fallback, and surge duplicate controls.

`full-turn.mjs` adapts the retained author probe. It drives real coordinator →
session adapter → ApplicationRunLoop → Record/native logger/writer/fsync → exact
flushed byte-prefix copy → public envelope reader/replay → fresh runtime import →
actual next fake-model request. Only client/model and harmless counter tools are
fake. The fresh tool registry is empty. The cut is not SIGKILL or power-loss proof.
The supplemental controls are a disposable experiment, not a permanent example
unit suite; final-envelope variants are not misrepresented as full-turn evidence.
The cross-turn legacy probe preserves the independent review's reproduction and
adds ordered-output and ledger-ownership assertions.

## Project tiers

| Command | Observed result | Evidence stem |
| --- | --- | --- |
| `pnpm typecheck` | pass | `typecheck-final` |
| `pnpm lint` | pass (31 existing warnings) | `lint-final` |
| `pnpm check:no-unit-tests` | pass | `no-unit-tests` |
| `pnpm test:integration source/services/agent-runtime/agent-runtime.integration.test.ts` | 10 passed | `runtime-integration` |
| `pnpm test:integration` | 223 passed, 4 failed, 1 skipped | `integration` |
| `pnpm test` | 28 passed | `static` |
| `pnpm verify:generated --target history --runs 1000` | 3 properties × 1000 passed | `generated-history-fixed` |
| `pnpm test:e2e` | 32 passed, 4 skipped | `e2e` |
| `pnpm test:provider-black-box` | 222 passed, 1 skipped | `provider-black-box` |

Each stem has `.log` and `.exit`. Initial lint failures (probe imports then JSON
formatting) and the generated-oracle metadata failure remain visible. The full
integration failures are Bare CLI sandbox assertions: flag/config write blocked,
outside-workspace denial text differs, and scratch write absent. The same four
signatures reproduce with all changed source restored to HEAD and the new source
module temporarily removed: `base-cli-confirmed.log`. Source was restored in
finally. `base-cli.log` is an earlier **invalid comparison**: the new module was
still present and caused a build failure; it is not baseline evidence. No guard
was disabled and no sandbox authorization changed to turn these failures green.
Full integration remains non-green; independent review remains pending.

## Retro

Preventable: yes. Origin commit unknown; provider-ID uniqueness was not a valid
runtime contract. Root cause: live admissions were plural while persistence joins
used a single call-ID key; the initial migration's payload-only alignment then
crossed authoritative user-turn boundaries. Blast radius: stale recovered context,
not demonstrated re-execution or blanket loss of displayed command outputs.

Structural hardening: a ledger-owned ordinal plus shared key/pairing routine
replaces duplicated uniqueness assumptions. The offline boundary journey would
fail on both the original collapse and the reviewed cross-turn escape.

Checklist: (1) representability: optional metadata preserves old data, so legacy
ambiguity remains; (2) source of truth: existing admission ledger, no new counter;
(3) boundary: canonical/persisted identity is validated and propagated; (4) implicit
coupling: shared key at recovery/history/guard joins; (5) wrong assumption: provider
ID or equal payload implied same execution; (6) detection gap: method-local tests
missed native restart and the initial probe missed two user turns; (7) automation:
entrypoint now includes independently supplied cross-turn request assertions;
(8) siblings: all alignment callers inspected, only authoritative-final caller
scoped, accumulated callers preserved; journal, direct result, history repair,
segment and surge consumers migrated; (9) knowledge: turn-local ownership is now
explicit here and in the pairing API; (10) observability: exact source inventories,
JSONL prefixes and actual request observations make loss visible offline;
(11) origin: unknown, no ungrounded introduction-date attribution. No broader
store, protocol, approval-state-machine or exactly-once redesign is warranted.

## Packaging handoff

`.coord/` is ignored (`git check-ignore` confirms); only the requested summary is
written there. Parent/runtime owns packaging and independent inspection. Eligible
changes are the tracked source diff (contracts, ledger, journal, replay/history,
normalization, schema and surge), new `source/services/conversation/tool-occurrence.ts`,
the generated oracle, scoped contract/guard documentation, isolated evidence
ledgers, and this experiment directory. No original registry/ledger, coordinator
runtime, task internals, merge, push or publish was modified.
