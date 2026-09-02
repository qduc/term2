# Test-audit calibration readiness

Prepared 2026-09-02 at `7ade9e413327796a36cb4f637e29672523a2d9a2`.

This packet prepares the next read-only calibration wave. It does not authorize
reviewer dispatch, change the source graph, or recommend changing any test.

## Current inventory

Vitest collected 7,503 test cases from 582 files. Collection loads the test graph
but does not execute the tests, so this is an inventory snapshot rather than a
passing-suite result or runtime baseline.

Reproduce it from the repository root:

```bash
NODE_ENV=test pnpm exec vitest list \
  --json=/tmp/term2-test-audit-list-2026-09-02.json

jq '{
  cases: length,
  files: ([.[].file] | unique | length)
}' /tmp/term2-test-audit-list-2026-09-02.json
```

The prior baseline at `c61909ea` executed 5,810 tests from 459 files. Its runtime
and slow-file ranking must not be presented as current. The difference in case
counts is directional only because the old number came from an executed run while
the current number comes from collection. The file-count increase from 459 to 582
is directly comparable.

Applying the existing first-match shard rules to the current 582 files assigns
every file, with no unassigned path:

| Shard | Current files | Prior files |
| --- | ---: | ---: |
| `approval` | 15 | 14 |
| `conversation` | 38 | 30 |
| `entrypoints` | 41 | 19 |
| `hooks` | 36 | 31 |
| `observability` | 22 | 17 |
| `platform-services` | 47 | 33 |
| `prompts-commands` | 18 | 12 |
| `provider-blackbox` | 15 | 15 |
| `providers` | 56 | 39 |
| `runtime` | 51 | 43 |
| `session` | 53 | 44 |
| `settings-config` | 15 | 14 |
| `shell` | 32 | 27 |
| `subagents` | 24 | 21 |
| `tools` | 29 | 26 |
| `ui-components` | 54 | 44 |
| `utils` | 36 | 29 |

The rules still provide complete ownership, but `entrypoints`, `providers`, and
`platform-services` have grown enough that their coherence and assignment size
should be reconsidered before domain exploration. Calibration does not need to wait
for that resharding.

## What calibration must prove

The four-file probe established that differently configured AI reviewers can state
observable contracts and make accurate sibling-coverage claims for tests worth
keeping. It did not establish discrimination: both reviewers recommended `keep`
for all four files.

The next wave must answer four questions before broader review is funded:

1. Can a reviewer identify a defensible non-`keep` candidate?
2. Can another reviewer independently reproduce or meaningfully challenge it?
3. Do reviewers use comparable contract granularity?
4. Are factual claims about production seams and sibling coverage reliable enough
   to support a later human decision?

## Contract granularity rule

Use one contract for one externally observable rule that could change independently.
Group parameterized examples that exercise the same rule. Split cases only when a
caller could reasonably depend on one behavior while another changes.

Examples that differ only in input spelling, fixture construction, or internal
branch selection are evidence for one contract unless their externally observable
outcomes differ independently.

Start with one graph record per file. Expand to case records only when cases in that
file require different recommendations; do not expand merely to count examples.

## Proposed 16-file calibration sample

This is a stratified sample, not a set of suspected deletions. It mixes large,
high-risk boundaries with clusters where consolidation is plausible enough to test
reviewer discrimination.

### Load-bearing boundary files

- `source/services/agent-runtime/application-run-loop.test.ts`
- `source/providers/codex-responses-model.test.ts`
- `source/components/message/CommandMessage.test.tsx`
- `source/tools/system/shell.test.ts`

### Session cluster

- `source/services/session/conversation-session.characterization.test.ts`
- `source/services/session/conversation-session.isolation.test.ts`
- `source/services/session/conversation-session.lifecycle.test.ts`
- `source/services/session/conversation-session.stream.test.ts`

### Subagent-manager cluster

- `source/services/subagents/subagent-manager.lifecycle.test.ts`
- `source/services/subagents/subagent-manager.misc.test.ts`
- `source/services/subagents/subagent-manager.roles.test.ts`
- `source/services/subagents/subagent-manager.security.test.ts`

### Command-safety cluster

- `source/utils/shell/command-safety.test.ts`
- `source/utils/shell/command-safety.git.test.ts`
- `source/utils/shell/command-safety.path.test.ts`
- `source/utils/shell/command-safety.red-yellow-policy.test.ts`

Before dispatch, the coordinator must independently inspect at least two sample
files and record their expected classifications in an artifact excluded from both
reviewers. At least one control must be a defensible non-`keep` decision. If no
sample file supports that decision, replace one file rather than manufacturing a
negative judgment.

## Reviewer and adjudication design

- Use two differently configured reviewers. They receive identical source inputs
  and the same schema-valid example, but cannot read each other's artifact or the
  coordinator controls.
- Both passes are read-only and use `role: second_opinion`. Neither reviewer writes
  the decision of record.
- Validate each artifact before comparison.
- The coordinator spot-checks every factual claim supporting a non-`keep` decision,
  every claimed replacement, and a sample of ordinary `keep` decisions.
- A human reviews deletion candidates, high-risk non-`keep` decisions, unresolved
  disagreements, and any conclusion that depends on behavior outside the assigned
  domain.

## Go/no-go criteria

Proceed to domain exploration only when all of these hold:

- Both artifacts account for all 16 assigned files and validate successfully.
- At least one reviewer produces a non-`keep` recommendation that survives source
  verification and adjudication.
- No checked replacement or sibling-coverage claim is invented or materially
  overstated.
- Reviewers apply the contract granularity rule consistently enough that their
  records can be reconciled without redoing the source analysis.
- The coordinator records disagreements and rubric changes before merging any
  decision of record.

If factual coverage claims fail, stop. If every recommendation is `keep`, use the
reviewers only for inventory work until a second calibration demonstrates
discrimination. Do not interpret agreement by itself as correctness.

## Gate for newly added tests

Apply this review block to new test files and material additions. It is a review
prompt, not a test-count quota:

```markdown
### Test evidence

- Behavior contract:
- Risk or escaped defect protected:
- Evidence the test fails without the behavior (red test, reverted fix, or focused mutation):
- Existing sibling coverage inspected:
- Why this test adds unique or stronger evidence:
- Why this is the correct suite and test layer:
- Determinism and boundary mocks:
```

The evidence can be brief. A test should not be accepted solely because it raises
line coverage, snapshots current output, or exercises another input permutation.
Missing mutation evidence is not an automatic rejection when producing it would be
disproportionate, but the reviewer should then require a concrete defect story and
unique-signal argument.

## First authorized execution step

Once the calibration wave is approved:

1. Create a dedicated calibration worktree from current `main`.
2. Refresh the commit and inventory fields in both reviewer assignments.
3. Produce the excluded coordinator-control artifact.
4. Dispatch the two independent read-only reviews.
5. Validate, reconcile, and publish the calibration report.

Do not refresh the runtime baseline concurrently with reviewers. Runtime measurement
owns the machine during its run and should happen once, separately, before any
cleanup batch makes performance claims.
