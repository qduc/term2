# Mutation testing proportionality (recommendation)

Date: 2026-09-04 · Author: test-audit coordinator · Status: **recommendation for
user approval — not implemented**

The Milestone 4 deferred decision asked whether mutation testing is proportional
for disputed high-value contracts. This file answers with evidence from the
audit graph (`docs/test-audit/graph.yaml`, 602 tests / 694 contracts / 1224
decisions) and from suite measurements. It names the specific contracts that
would justify the technique and gives a rough cost. No mutation runner is
installed today (checked `package.json`/`pnpm-lock.yaml` on 2026-09-04), so any
adoption starts with tooling.

## What the evidence says about the need

- **The suite is healthy but not mutation-empty.** 389 risks are recorded (101
  critical, 220 high) across 694 contracts, but only **48 tests** remain where a
  second opinion disagrees with the primary decision, and after the Topology
  batch only **three** non-`keep` primaries remain: two `rewrite_candidate`
  (shell-command-safety relabel/table; use-settings-completion localized
  repairs) and one `architecture_signal` (docker-host-control.integration,
  report-only). The audit's own triage already located the weak tests more
  cheaply than a mutation campaign would.
- **The cost driver is wide harness files.** A mutation pass re-runs a file's
  covering tests once per mutant. Contracts whose coverage is a small, fast test
  file are cheap to mutate; contracts covered only by multi-file integration
  harnesses are not.
- **Mutation testing finds what the audit already flagged.** The two remaining
  `rewrite_candidate` files are cases where tests exist but are weak (tautology
  assertions, stale vocabulary, under-constrained boundaries). Mutation testing
  detects *missing* assertions on covered lines; the audit detected these with
  read-through review. Paying for both on the same seams is double-spend.

## Where it IS proportional (named contracts)

Mutation testing is justified only where all of: (a) severity is critical,
(b) the seam is a branchy pure function with cheap covering tests, and
(c) the tests are the sole or near-sole guard on that seam.

1. **`shell-command-classification`** (critical) — the RED/GREEN/YELLOW
   classifier (`source/utils/shell/command-safety/index.ts` + `path-analysis.ts`,
   ~700 LOC; contract statement: "Shell command and path forms are classified
   with the intended GREEN, YELLOW, or RED severity, including nested
   executors"). `validateCommandSafety` is the boolean gate `shell.ts` calls and
   is tested only by this module's own files. Estimated ~150-250 mutants at
   ~1 per 4 covered LOC; each mutant re-runs the command-safety test set
   (~8 files, a few seconds isolated) → **roughly 20-40 CI-minutes per full
   pass**, run on demand.
   **Gate:** do not run this before the pending `shell-command-safety` relabel /
   table-drive batch lands (still `rewrite_candidate/medium`); mutating a test
   file mid-rewrite wastes the pass. Revisit after that batch.
2. **`observability-chain-fingerprint`** (critical ×2) — the chain-recovery
   fingerprint builder (`source/services/retry/chain-recovery-fingerprint.ts`,
   34 LOC) whose statement enumerates inclusions (provider, model,
   previous-response identity, item types, call IDs) and exclusions (request and
   tool-output bodies). Fingerprint builders are the classic mutation target: a
   dropped field or added exclusion changes chain continuity silently. Coverage
   is one small file (48 LOC). Estimated **~10-20 mutants → a few minutes**.
   Cheap enough to run once as a one-off proof, then decide whether to repeat.

## Where it is NOT proportional

- **`shell-sandbox-and-approval`** (critical) is covered by **13 test files**,
  several of which are PTY/process harnesses. A full mutation pass means
  re-running that set 150+ times → many CI-hours with high flake risk. The
  security value is real but the audit's coverage review plus the existing
  sandbox subprocess tests are the proportional control.
- **`session-approval-state` / `session-continuity`** (critical ×2 each) are
  covered only by the four heavy `conversation-session.*` harness files. Same
  economics as above, plus these files exercise full session lifecycles where a
  mutant triage is dominated by harness noise.
- **A standing suite-wide gate.** 694 contracts × critical/high risk cannot be
  mutated at repo scale without a dedicated mutation budget that dwarfs the
  ~3-minute full suite; the audit already prioritizes where evidence is weak.

## Rough cost summary

| Option | Cost |
| --- | --- |
| Tooling: introduce a Vitest-compatible mutation runner (e.g. Stryker) | new devDependency + lockfile/security review + config + CI job template: ~1 dev-day, on the repo owner |
| One full pass, `shell-command-classification` (post-relabel) | ~150-250 mutants, ~20-40 CI-minutes per pass |
| One full pass, `observability-chain-fingerprint` | ~10-20 mutants, a few minutes |
| Both as an on-demand CI workflow | ~30-60 minutes per manual run; do **not** gate PRs |

## Recommendation

Do not adopt mutation testing as a standing gate. Approve it as an **optional,
on-demand, single-seam exercise** for the two named contracts above, run after
the pending command-safety relabel batch lands. Expected value: independent
confirmation that the classifier's severity flips and the fingerprint's
field set are each caught; expected cost: roughly one dev-day of tooling plus
~1 CI-hour total per full round. Everything else the audit data shows as
disputed is cheaper to keep under read-through review.
