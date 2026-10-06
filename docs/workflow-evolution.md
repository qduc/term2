# A first workflow improvement loop

This opt-in adapter records one experiment without adding an execution engine.
The main agent performs useful work and proposes a method change; Term2's
existing Reviewer independently checks paired artifacts. A local event ledger
validates the records, computes a decision and verifies subsequent loaded-method
identity. It does not run models, edit skills, install methods or grant authority.

The methodology is the public `agentic-loop` and `workflow-evolution` at
[qduc/skills b29db03](https://github.com/qduc/skills/tree/b29db03f876a0a5965767785c185357577e3488d).
The integration was inspected against Term2 `efeda93af2ca1b94f09ae8758b0e45dd1a9d1f74`:
`SkillsService` caches bodies and resolves project overrides, the Reviewer role
uses independent explorers, and `WorkflowEvaluatorImpl` supports bounded trials
but does not expose skill attachment or nested agents to workflow children.

## Try the deterministic slice

From a checkout with dependencies installed, choose a **new** output directory:

```sh
pnpm exec tsx source/services/workflow-evolution/demo.ts .term2/evolution/demo
pnpm exec tsx source/services/workflow-evolution/cli.ts show .term2/evolution/demo/experiment.json
pnpm exec tsx source/services/workflow-evolution/cli.ts hash .term2/evolution/demo/frozen-benchmark.json
```

The demo does actual local artifact work: it creates Markdown tables of contents.
Two observed documents expose duplicate anchors. One versioned candidate adds
duplicate suffixes, and three frozen documents are checked against predeclared
expected artifacts. A deterministic independent Reviewer substitute re-reads
the persisted inputs and outputs, then supplies the paired results. The ledger
records `keep`, a **fixture-only** approval and the candidate identity on a new
document. It writes inputs, outputs, expected artifacts and the complete event
history. Repeating the command on that ledger refuses before overwriting work.

This verifies control flow and the deterministic fixture transformation. It is
not evidence of model-quality improvement, autonomous weight training, or the
live Reviewer integration. No provider or paid model call runs in this example.

## Use it from Term2

Ask the main agent to activate `workflow-evolution-ledger`, improve one
repeatedly used task-local method, and retain records under `.term2/evolution/`.
The skill describes the main-agent/Reviewer procedure and preserves existing
approvals. It is an operator workflow, not an automatic background hook. No
changes to agent/tool registration, settings, provider dispatch or session
indexing are needed. `run_agent_workflow`, if enabled, is optional for trials;
the independent Reviewer is invoked from the main agent through `run_subagent`.

The CLI accepts a JSON event file. Its general write form is
`cli.ts append <ledger-path> <event-json-path>`; the exported `appendEvent`
function accepts the same event object. See `eventSchema` in
`source/services/workflow-evolution/experiment.ts` for the strict input contract.
The demo is also a complete executable example of every event except rollback.

| Event | Required record | Effect |
| --- | --- | --- |
| `init` | ID, incumbent snapshot, frozen criteria | Freeze original identity, input digests, checks, conditions and thresholds |
| `run` | ID, task/input, purpose, expected ID, loaded snapshot, exact 40-character harness commit, conditions ID, producer/session, metrics, evidence | Retain task outcome; ordinary work must match the active method |
| `propose` | ID, separately versioned candidate, weakness, hypothesis, mutation, at least two observed run IDs | Freeze one candidate supported by repeated weakness on distinct inputs |
| `compare` | ID, criteria ID, fresh Reviewer session, paired run IDs, corroborated metrics, results for every frozen check, evidence | Record independent comparison and computed decision once |
| `promote` | ID, approval reference naming candidate ID and review ID | Select a kept candidate in the ledger; no skill/runtime write |
| `rollback` | ID, reason, evidence | Restore original selection and preserve the promotion reference |

Methods are `{name, revision, source, body}` snapshots. `digest` hashes canonical
JSON with sorted object keys and significant body whitespace. `contentDigest`
hashes evidence file bytes. Input and conditions IDs are canonical JSON hashes.
Evidence is a nonempty array of `{ref, digest}`; use retained artifacts with
their byte hashes, including Reviewer output and loaded-method traces. The
ledger validates hash shapes and links but does not resolve references or
re-run checks: that is the independent reviewer/operator's responsibility.

Metrics are `outcome: pass | fail | uncertain`, `interventions` and `retries`.
The frozen check results must aggregate to the recorded outcome. Any candidate
failure or increase in intervention/retry counts rejects. All frozen tasks
must be covered (at least three), with at least two task wins and no regression,
for `keep`. A win is corrected failure or fewer interventions/retries while
passing every check. Missing coverage, uncertainty, incomparable paired harness
commits or too few wins produces `inconclusive`. Ties do not promote. This v1
uses sample floors to prevent anecdotal promotion, not to establish statistical
confidence. High-variance results must be marked uncertain; repeated-seed
evaluation needs a separately designed experiment rather than treating duplicate
input copies as new independent tasks. This v1
does not evaluate cost or latency gains: freeze a comparable resource envelope
and use a different experiment design if those tradeoffs define better.

Capture actual loaded instructions rather than hashing a changed file. Existing
host code can use `snapshotLoadedSkill(skillInfo, revision)` on the object
returned by `SkillsService.activateSkill`. A main agent using `activate_skill`
must retain its returned body and resolved directory in its run trace. When
using explicit instructions for disposable trials, capture the snapshot actually
passed in. A candidate file on disk is not adoption evidence. Referenced resource
files are not automatically snapshotted: freeze their versions/hashes in
conditions and retain them as evidence; do not vary them between paired runs.

Promotion first changes **selection**. An authorized operator must separately
install/reload that task-local method through the existing host mechanisms.
The first later ordinary `run` with the exact selected loaded snapshot records
`adoption: {promotionId, runId, methodId}`. A cached or shadowed incumbent fails
identity validation. Adoption does not imply efficacy: a failing next task can
still prove which method was loaded. Rollback similarly restores ledger
selection; the operator must restore/reload the real method and record its next
loaded snapshot. Both original and candidate bodies remain in history.

## Boundaries and verification

CLI records are caller-supplied. A different Reviewer session and an approval
reference are checked structurally; they are not authenticated permissions or
proof that a real Reviewer ran. Preserve actual host transcripts and honor host
approval decisions. A candidate can neither change criteria through this API nor
overwrite a governing skill through it, but the ledger cannot prove that prose
preserves every safety rule. The independent Reviewer must check that claim.
Do not use this as a security boundary against a caller who can edit the ledger.

The reducer allows one candidate, one comparison and one promotion per
experiment. It launches no agents and performs no automatic retries. The
operator skill scopes trials to one paired run per frozen task and existing
host resource/approval limits; those trial-count instructions are methodology,
not new runtime enforcement. A failed/uncertain experiment keeps the incumbent.
Changed criteria require a new, explicitly authorized experiment.

Writes use an exclusive writer lock, a synced temporary file and atomic rename.
Failed validation preserves the prior log. Readers replay the event history
instead of trusting an editable state snapshot. A crashed writer may leave
`<ledger>.lock`; inspect the owning process before removing only that stale
lock. There is no automatic lock stealing, retry loop, retention eviction or
power-loss durability guarantee. Preserve evidence alongside the local ledger;
it is not automatically uploaded or committed.

The decision admission contract prevents unsupported adoption within this
opt-in ledger. `applyEvent` owns enforcement and recovery: frozen task/check
identities and corroborated metrics are direct structural evidence; their
sample counts are a conservative proxy for repeated improvement. Legitimate
small or noisy studies remain inconclusive with their evidence retained. The
schema floors are three distinct task inputs and two wins, with stricter values
allowed at initialization. There are no settings, migrations, automatic
fallbacks or retries. Decision reasons and promotion/adoption/rollback IDs expose
the transitions. Rollback is limited to local selection and preserves history.

Run the focused unit and filesystem integration checks:

```sh
NODE_ENV=test pnpm exec vitest run source/services/workflow-evolution/experiment.test.ts
NODE_ENV=test pnpm exec vitest run --config vitest.integration.config.ts source/services/workflow-evolution/ledger.integration.test.ts
```

PR correctness review examines this implementation and its contracts. Workflow
efficacy review examines the independently observed task results under frozen
criteria. A green code test or a successful PR review cannot substitute for the
latter. Live model efficacy and live Reviewer operation remain unverified by
the deterministic slice.
