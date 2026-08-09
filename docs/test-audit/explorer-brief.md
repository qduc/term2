# Test audit explorer brief

Use this brief only after the calibration wave is approved. Replace every value in
the Assignment section before dispatch; the rest is the shared contract.

## Assignment

- Domain: `<domain-id>`
- Reviewer id: `<your unique reviewer id>`
- Included paths: `<explicit paths>`
- Excluded paths: `<explicit paths>`
- Graph input: `docs/test-audit/graph.yaml` at `<commit>`
- Output path: `<unique artifact path>`

Every test id you emit must begin with `<domain-id>-`, and every decision must carry
your reviewer id. Artifacts are merged later; unnamespaced ids collide and
unattributed judgments cannot be reviewed independently.

## Objective

Map the assigned tests to the observable Behavior Contracts they support and return
evidence-backed maintenance candidates. Complete the assigned inventory; uncertainty
is a `needs_review` result, not a reason to omit a test.

## Steps

1. Read every assigned test file and the production boundary it exercises. This step
   is complete when every assigned file is accounted for.
2. State each observable Behavior Contract in plain language. Separate contracts
   that can change independently. This step is complete when every test maps to at
   least one contract.
3. Locate sibling coverage inside the assigned domain. Record exact test IDs or
   paths; do not infer cross-domain redundancy. This step is complete when every
   duplication claim has a concrete comparison target.
4. Record fixtures, mock boundaries, implementation coupling, regression provenance,
   and the realistic defect that could escape if the test vanished. This step is
   complete when every recommendation cites evidence.
5. Start with one `kind: file` record per file. Expand to `kind: case` only when
   cases need different contracts or recommendations. Return graph records conforming
   to the current schema. Run
   `pnpm test-audit validate --graph <artifact>` before reporting completion.

## Recommendation rules

- `keep`: uniquely or proportionally protects a meaningful contract.
- `rewrite_candidate`: the contract matters, but the test observes implementation
  details or expresses it weakly.
- `consolidation_candidate`: another named test can carry the same contract more
  strongly or cheaply.
- `retier_candidate`: the evidence matters, but its execution cost does not belong
  in its current suite tier.
- `deletion_candidate`: named retained coverage protects every contract, or the
  behavior is demonstrably no longer a contract. Name the retained tests in
  `replacementTestIds`; the validator rejects an unnamed deletion.
- `architecture_signal`: setup or mocking exposes a production ownership problem.
- `needs_review`: available evidence cannot support a stronger recommendation.

Recommendations are proposals. Record facts separately from judgments, use
`needs_review` when evidence is incomplete, and leave repository tests unchanged.

During a calibration wave, where two explorers cover the same files independently,
emit every decision with `role: second_opinion`. Neither pass is the decision of
record; the coordinator reconciles them and writes the `primary`. Do not read the
other explorer's artifact before submitting your own — agreement is only evidence if
it was reached separately.

## Required output

Return only:

1. The validated graph artifact path.
2. Counts by recommendation and confidence.
3. A short list of uncertainties requiring cross-domain review.
4. Any assigned files that could not be classified, with the blocking evidence.

Do not report runtime measurements. Central measurement owns performance evidence.
