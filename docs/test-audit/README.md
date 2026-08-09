# Test audit graph

`graph.yaml` is the source of truth for test-audit evidence and proposed decisions.
Keep measurements and judgments separate: runtime belongs in baseline evidence;
recommendations belong in `decisions`.

## Commands

```bash
pnpm test-audit validate
pnpm test-audit list --domain <domain-id>
pnpm test-audit list --recommendation <recommendation>
pnpm test-audit list --undecided
pnpm test-audit show <test-id>
pnpm test-audit report
pnpm test-audit merge <artifact...> --out <path>
```

Pass `--graph <path>` to inspect a calibration or explorer artifact without replacing
the source graph.

## Records

- `domains`, `suites`, `seams`, and `fixtures` contain `{ id, label }` nodes.
- `risks` additionally require `severity`: `low`, `medium`, `high`, or `critical`.
- `contracts` contain `id`, an observable `statement`, `seamIds`, and `riskIds`.
- `tests` contain `kind`, `id`, repository-relative `file`, `domainId`, `suiteId`,
  one or more `contractIds`, and `fixtureIds`. A `case` record additionally requires
  its test `title`.
- `decisions` contain `id`, `testId`, `role`, `reviewer`, `recommendation`,
  `confidence`, `reason`, one or more evidence statements, `replacementTestIds`,
  review `status`, and an optional `sourceArtifact`.

IDs use lowercase kebab case and are unique within their node type. All references
must resolve.

## Recording a judgment

A decision carries the identity of whoever made it. `role: primary` is the decision
of record and there is at most one per Test. `role: second_opinion` records an
independent reviewer's judgment beside it without overwriting it, which is what the
calibration wave and the mandatory review of deletion candidates produce. Two
decisions on the same Test must come from different reviewers; a reviewer cannot
second-review their own conclusion.

Only the decision of record removes a test. A second opinion proposing deletion
never subtracts evidence, and a deletion candidate with `status: rejected` keeps its
test, so it still counts as retained evidence.

## Deletion safety

A `deletion_candidate` must name at least one replacement in `replacementTestIds`;
"something else probably covers this" is not evidence. On top of that, the validator
evaluates deletion candidates as a set and rejects any set that would collectively
leave a Behavior Contract without retained evidence, including a group whose members
each name one another.

## Merging explorer artifacts

Explorers work independently and produce separate artifacts, so a test id must be
prefixed with its `domainId`. That namespacing is enforced, and it is what makes
non-overlapping domain assignments safe to combine.

`merge` unions shared vocabulary nodes by id and concatenates tests and decisions.
Two artifacts may legitimately discover the same contract, seam, or risk, but they
must describe it identically; a conflicting definition for the same id is a
reconciliation task for the coordinator, not something merge resolves on its own.
The merged result is validated before it is written.

## Granularity

Begin with `kind: file`. Expand a file into `kind: case` records only when individual
tests inside it need different contracts or recommendations. A path is recorded at
one granularity: a file record and case records for the same file would double-count
its evidence, so the validator rejects the mix.

The graph begins empty intentionally. Populate it through the approved calibration
wave rather than pre-classifying tests from filenames or timing alone.
