# Fresh-reader readback

Scope: independent reader assessment of `docs/design/conversation-core.md`, then
comparison with `experiments/conversation-actor/v2/DESIGN.md`. No implementation
was opened. The six answers below were written before reading the detailed design.

## Answers from the short page alone

1. **Steer editing during approval.** Edit the accepted submission record in the
   conversation's inbox. Waiting for approval preserves the current turn and its
   continuation; the steer stays editable until consumption at that turn's next
   model boundary. It is not an edit to approval state or provider history. If the
   turn never reaches another boundary, ordinary queue policy receives the steer.

2. **Tool connection fails, cancellation follows, then fresh input arrives.**
   Cancellation immediately removes the old turn's permission to advance. Fresh
   input can run once the relevant executions are proved stopped and queue policy
   makes that submission eligible. A connection failure alone is not described as
   stop proof. If it leaves an execution's status uncertain, replacement work must
   wait. The page does not say whether this particular connection failure created
   an execution, which executions are relevant, or how a failed connection proves
   no work can still make effects. I cannot determine an exact runnable instant
   from the failure description alone. Inputs retained by Stop remain paused;
   fresh input and explicit recovery resume have distinct policy treatment.

3. **Stop proof before tool result.** Proof establishes that the execution cannot
   keep making effects; it does not by itself supply the tool outcome. My inference
   is that a live turn waiting for a tool outcome continues waiting for its result,
   and may advance once that outcome is accepted. A cancelled turn never regains
   permission to advance from a late result; proof may release the barrier for
   replacement work. The page does not explicitly say what late results of a
   cancelled turn may contribute to the journal, or whether every live-turn path
   requires both proof and result. I would not invent either rule from this page.

4. **Background task across rollover.** The same execution survives, keeps its
   identity, and reports to the successor conversation/context and journal
   destination. It does not restart. Its owner has changed through backgrounding;
   its original turn can end. Retired work has no authority to alter the successor's
   turn or history. The page leaves the exact eligibility rule and distinction
   between a transferred eligible execution and retired work unspecified.

5. **Invalid provider anchor.** The journal/transcript's accepted facts supply a
   reconstructed provider-history projection with complete tool pairs. The
   provider adapter owns anchor reuse; a broken transport hint cannot be the only
   history copy. Exact reconstruction and rejection behavior are not specified.

6. **Turn fate and other layers.** The conversation is the single decision owner:
   admission/scheduling, current continuation, cancellation, ownership transfer,
   and acceptance of facts. The journal owns durability and order. UI and other
   observers receive events/snapshots. The provider adapter handles transport and
   reuse anchors, with input projected from accepted facts. Neither UI nor provider
   has an independent turn controller. Approval authority is acknowledged but its
   exact boundary is deliberately not explained here.

## Concepts supplied by this reader

No new lifecycle component was necessary. Two interpretations were needed and
remain explicitly conditional: a connection error is not automatically stop
evidence, and a live tool continuation needs an outcome even after stop proof.
The word "relevant" hides the key scope of the cancellation barrier. I treated
"successor" as the destination after rollover, without assuming a specific class,
mailbox, generation token, or durable actor implementation.

## Assessment before opening the detailed design

The page gives a coherent location for each of the six questions and separates
submission, turn, execution, journal, and projection without requiring service
names. It supports the basic steer, rollover, anchor, and owner answers directly.
The connection-failure and reversed-arrival cases are only conditionally
answerable: the important unknowns are stop-evidence validity, barrier scope, and
late-result acceptance. That is a limit of the short explanation, not evidence
that the design mishandles them.

This is a fresh-agent teachability proxy. It does not demonstrate that a human
reader understands the model, nor that production behavior implements it.

## Comparison after reading `v2/DESIGN.md`

The detailed design agrees with the six locations and basic ownership answers.
It resolves three material qualifications left by the short page:

- **Live foreground advancement needs both facts.** The detailed model explicitly
  requires result and stop evidence. The short page distinguishes the two facts
  but only explicitly ties the stop barrier to cancellation/replacement. My answer
  to the reversed-arrival case was correct for the requested order, but a reader
  could still incorrectly allow a live continuation to advance on result alone in
  the opposite order. This is a missing compact rule rather than a contradiction.
- **Revoked output is excluded from history.** The detailed model says a revoked
  execution's late result cannot enter history. The short page explicitly forbids
  retired work from changing the successor after rollover and forbids cancelled
  turns from advancing, but does not state the same history rule for cancellation
  without rollover. My initial answer appropriately left that unresolved.
- **Barrier scope depends on execution ownership.** The detailed model says normal
  background work does not block foreground admission, but retired session work
  does; conversation-scoped jobs can notify the successor. The short page's
  "relevant" and "eligible" defer this distinction. It locates the owner correctly,
  but cannot independently classify an arbitrary background job or connection
  failure. The detail also confirms that HTTP/tool rejection is not stop proof.

The anchor answer needs a production qualification: the detailed design preserves
provider/model/socket affinity, opaque provenance, compaction coverage and safe
unchained history, and explicitly leaves real serialization proof pending. My
short-page answer identifies the safe source of input, not a universal guarantee
that any accepted fact can simply be replayed on any provider. The short page's
claim that anchors are reuse hints is consistent with this distinction.

No implementation was inspected, and executable claims in the detailed design
were not independently verified in this assessment.

## Verdict

The short page passes the narrow location/ownership teachability proxy for this
reader: all six questions could be assigned to one coherent model without
inventing another controller. It only partially teaches the operational rules:
live advancement's two-fact requirement, cancelled-result history exclusion and
background barrier scope require the detailed page. These are bounded explanatory
gaps, not evidence of a need for a production rewrite. A stronger claim that a
human can predict the edge cases from the short page alone remains unestablished;
actual human readback and production parity are outside this evidence.

## Focused recheck after explanatory revision

The revised short page now explicitly states all three previously missing rules:
live foreground continuation requires outcome and stop evidence; outcomes known
before revocation remain facts while later results cannot alter the cancelled
turn's transcript; retired foreground/session executions hold replacement behind
the barrier while normal background work does not block admission.

The six scenario answers therefore remain stable, with stronger support for
answers 2 and 3 from the short page alone. A failed connection still needs its
execution contract to determine whether stop is proved, and "eligible" survivors
still require ownership policy to classify a particular task. Those are reasonable
detail boundaries, not hidden additional control owners. No new conceptual
controller or mechanism was needed to understand the revision.

Verdict: the identified explanatory gaps are addressed. This is a focused recheck
by an already primed reader, not a second independent fresh-reader trial or proof
of human comprehension. No implementation was opened for the recheck.
