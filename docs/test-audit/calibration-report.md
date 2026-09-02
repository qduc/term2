# Calibration report — 2026-09-02 wave

Run 2026-09-02 from the `test-audit-calibration` worktree at `d36c392a`. Two
independent read-only reviewers covered the same 16 test files, working without
sight of each other's artifact or the coordinator control. The wave is the
Milestone 2 gate: it exists to prove reviewer *discrimination*, which the
four-file probe did not.

## Setup

| | Reviewer neutral | Reviewer adversarial |
| --- | --- | --- |
| reviewer id | `calibration-neutral` | `calibration-adversarial` |
| stance | shared brief as written | shared brief + active waste-hunting mandate |
| artifacts | `docs/test-audit/calibration-neutral.yaml` | `docs/test-audit/calibration-adversarial.yaml` |
| role on every decision | `second_opinion` | `second_opinion` |

Both reviewers ran on the same harness/model with different stances. The
readiness packet preferred differently-configured reviewers, and the divergence
here was large (17 `keep` vs 9), so stance differentiation produced real
discrimination; the same-model caveat from `calibration-readiness.md` still
weakens agreement-as-evidence and is recorded as such.

Shared inputs: `README.md`, `explorer-brief.md`, `graph.yaml`, and a synthetic
schema-valid example (`calibration-example.yaml`, validated 1 test / 1 contract /
2 decisions). Coordinator control `control/calibration-control.yaml` recorded
expected classifications before dispatch. Exclusion is instruction-level (the
control lives in the repo); no evidence of leakage was found — the neutral
reviewer disagreed with the control on two of its three non-`keep` picks, which
is not the pattern a leaked control would produce.

Sample: 16 files per `calibration-readiness.md` (4 load-bearing, 4
conversation-session, 4 subagent-manager, 4 command-safety).

## Artifacts

- `calibration-neutral.yaml`: 19 test records (15 file + 4 case-level on
  `red-yellow-policy`), 42 contracts, 19 decisions; validates.
- `calibration-adversarial.yaml`: 16 file-level test records, 29 contracts, 16
  decisions; validates. Did not expand `red-yellow-policy` to cases — the one
  granularity divergence of the wave.

Both artifacts account for all 16 assigned files. Neither reviewer returned a
`deletion_candidate` or `retier_candidate`; no test was removed, rewritten, or
re-tiered during calibration.

## Verdicts by recommendation

| | neutral | adversarial |
| --- | --- | --- |
| keep | 17 (high) | 9 (8 high, 1 medium) |
| rewrite_candidate | 0 | 5 (3 high, 2 medium) |
| consolidation_candidate | 1 (medium) | 0 |
| architecture_signal | 0 | 2 (high) |
| needs_review | 1 (medium) | 0 |

## Factual spot-checks

Every non-`keep` claim and a sample of `keep` claims were verified against the
source. All held, one with a scope correction:

- neutral: `red-yellow-policy` paths-case duplication — its three inputs
  `/etc/passwd`, `/var/log/system.log`, `../secrets.json` are each asserted
  YELLOW in `command-safety.path.test.ts` (traversal and absolute-system-paths
  cases). Accurate (the reviewer understated: all three strings, not two).
- neutral: characterization `needs_review` — sibling `stream.test.ts` does
  assert approval-continuation event order. Accurate.
- adversarial: `misc` orphan rewrite — verified (only `RealSubagentManager`
  construction in tests; dead imports incl. `TestSubagentManager`, `ROLE_*`,
  `MAX_SUBAGENT_MODEL_RETRIES`, `ModelBehaviorError`, three fixture/stream
  helpers).
- adversarial: `git` rewrite — verified (22 singleton `it`s, unique content).
- adversarial: `security` rewrite — three near-identical unsandboxed-wrapper
  cases verified verbatim.
- adversarial: `characterization` architecture signal — 24 references to
  `approvalState`/`statusMachine`/`toolTracker`/`TurnItemAccumulator` verified.
- adversarial: `roles` explorer overlap — the explorer web-tools observable is
  also asserted in same-domain sibling `subagent-manager.tools.test.ts`; the
  claim of an *exact* surface overlap was softened to partial on verification.

## Adjudicated decisions of record

Canonical granularity follows the neutral reviewer's records (the finer one);
the adversarial file-level view of `red-yellow-policy` is recorded as a
granularity dissent. Full records with evidence live in
`docs/test-audit/graph.yaml` (19 test records, 53 decisions: 19 primary, 19
neutral second opinions, 15 attachable adversarial second opinions; the
adversarial file-level red-yellow decision does not attach to a canonical
record and is preserved only in its artifact).

Primary (coordinator) decisions:

| Test record | Primary | Confidence |
| --- | --- | --- |
| runtime-application-run-loop | keep | high |
| providers-codex-responses-model | keep | high |
| ui-components-command-message | keep | high |
| shell-system-shell (`tools/system/shell.test.ts`) | keep | high |
| session-conversation-session-characterization | keep | high |
| session-conversation-session-isolation | keep | high |
| session-conversation-session-lifecycle | keep | high |
| session-conversation-session-stream | keep | high |
| subagents-subagent-manager-lifecycle | keep | high |
| subagents-subagent-manager-misc | rewrite_candidate | medium |
| subagents-subagent-manager-roles | keep | high |
| subagents-subagent-manager-security | keep | high |
| shell-command-safety (core wrapper) | rewrite_candidate | medium |
| shell-command-safety-git | rewrite_candidate | medium |
| shell-command-safety-path | keep | high |
| shell-command-safety-red-yellow-policy: ambiguous | keep | high |
| shell-command-safety-red-yellow-policy: dangerous | keep | high |
| shell-command-safety-red-yellow-policy: paths | consolidation_candidate | medium |
| shell-command-safety-red-yellow-policy: workspace | keep | high |

Milestone 4 candidates produced by calibration (none destructive without a
named replacement; the consolidation names `shell-command-safety-path`):
rewrite `misc` (dead imports / fold into failure table), rewrite `git` (it.each
table), rewrite core wrapper (relabel + table, tests only), consolidate the
red-yellow-policy paths case, plus form-level options recorded as second
opinions (roles/security tables; shell-tool and characterization ownership
signals, which are cross-domain and deferred to Milestone 3).

## Disagreements recorded

- `misc`: neutral keep/high vs adversarial rewrite/high → primary rewrite/medium
  (2v1 with the control; verified orphan/dead-import evidence).
- `git`: neutral keep/high vs adversarial rewrite/medium → primary
  rewrite/medium (2v1 with the control).
- core `command-safety`: neutral keep/high vs adversarial rewrite/high →
  primary rewrite/medium. The seam under test is production-live
  (`validateCommandSafety` is the gate `shell.ts` calls), so the rewrite is
  relabel-and-table only.
- `roles` and `security`: neutral keep/high vs adversarial rewrite/medium →
  primary keep/high with form-level notes; both are high-scrutiny and their
  adversarial evidence is about expression, not redundancy of contracts.
- `red-yellow-policy` granularity: neutral case-expanded, adversarial kept
  file-level → canonical records are case-level; the paths case is the single
  consolidation candidate, the other three cases keep.
- `characterization`: neutral needs_review vs adversarial architecture_signal →
  primary keep/high with the ownership question deferred to Milestone 3
  cross-domain reconciliation (the file spans session/approval seams).
- `shell.test.ts`: adversarial architecture_signal → primary keep/high with the
  production ownership question queued for the Milestone 3 tools-domain
  artifact.

## Go/no-go

All five readiness criteria hold:

1. Both artifacts account for all 16 files and validate. ✓
2. More than one non-`keep` recommendation survives source verification and
   adjudication (consolidation of the paths case; rewrites of `misc`, `git`,
   and the core wrapper; two architecture signals). ✓
3. No checked replacement or sibling-coverage claim was invented; the single
   scope correction (roles overlap: exact → partial) did not change the
   conclusion. ✓
4. The contract-granularity rule reconciled without redoing source analysis;
   the one divergence (red-yellow-policy file vs case) is documented and
   canonicalized at case level. ✓
5. Disagreements and the granularity canon are recorded here before any
   decision of record was merged into `graph.yaml`. ✓

**Verdict: PASS. Domain exploration is authorized.** The probe's open question
is answered: reviewer discrimination is demonstrated — the adversarial stance
reached seven non-`keep` decisions, its factual claims survived verification,
and the two reviewers disagreed in the directions their stances predict rather
than converging on `keep`.

## Milestone 3 readiness

- Live inventory at `d36c392a` is 585 test files (582 at packet time; the
  image-fix merges added 2 in `tools`, 1 in `platform-services`). All 585
  assign to the 17 shard rules with none unassigned.
- The 16 calibration files now have canonical graph records and are excluded
  from Milestone 3 assignments (their domains still get the remaining files).
- Six shards exceed the ~35-file reviewer ceiling and will run as two disjoint
  sub-assignments each: `providers` (56), `ui-components` (54), `session` (53),
  `runtime` (51), `platform-services` (48), `entrypoints` (41).
- Deferred cross-domain ownership items from this wave: shell-tool construction
  seam (tools/shell), characterization reach-through (session × approval),
  roles/tools explorer-surface overlap (subagents).
