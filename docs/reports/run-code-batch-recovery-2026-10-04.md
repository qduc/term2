# Failed-batch result recovery

## Delivered contract

`RunCodeExecutionCall.recovery` retains an immutable snapshot of the normalized,
bounded script-visible value after successful nested tool settlement. Failed
scripts render completed call evidence, including call identity, tool, outcome,
result, and available truncation metadata. This does not replay calls, fabricate
action receipts, or declare task success. Late settlement after abort does not
retain a recovered success. Existing final-output clipping and artifacts remain
the aggregate output boundary.

Overflow strings use the existing artifact writer; storage failure is explicitly
marked unavailable. Media markers remain inert rather than recovered attachments.
Structured overflow retains the existing rejection and artifact diagnostic.
Recovery covers nested tools, not the separate agent capability. Repeated calls
to one tool are distinguished by call ID, not source position or arguments.

## Validation

- Clean baseline: 129 focused tests passed in the preceding session.
- Regression tests were observed red before implementation there.
- Final focused recovery suite: 133 passed.
- Related gate: 143 files, 2,863 passed, 2 expected failures.
- Changed gate after composition: 144 files, 2,878 passed, 2 expected failures.
- Typecheck and `git diff --check` passed.
- Recovery gate chain elapsed 152.4 seconds; final changed/typecheck chain
  elapsed 70.9 seconds. Both exited zero.

Implementation was performed directly by the coordinator after selected native
worker launches failed for pool availability. No independent model review was
completed; these are coordinator inspection and executable-check results.

## Proportional retrospective

The defect was preventable: the ledger represented successful call counts but
not results, so a later script error erased usable evidence. Existing tests
asserted a warning rather than preservation. The typed recovery field and
public-boundary tests now cover partial failure, immutable snapshots, clipped
string retrieval, storage failure honesty, and completed mutations without
fabricated receipts. Success and failure share the normalized settlement seam;
structured overflow and final clipping keep their existing artifact mechanisms.
Agent-capability results remain outside this seam and are a declared limitation.

## Session hiccups

- `python` was unavailable; using `python3` resumed the helper successfully.
  This was a local invocation mistake, not evidence of a product bug.
- Regex searches twice lost a needed escape at the tool boundary and failed
  parsing. Simpler patterns or fixed-string searches worked. No data changed;
  exact transport cause remains unverified.
- Composition tests initially lacked an outer call ID, so structured execution
  evidence was absent. Binding the invocation identity fixed the fixture;
  the public rendered return still existed. No production change was justified.
- `TimeoutNaNWarning` was reproduced in Codex provider tests. One settings
  fixture returned a model ID for newly consumed numeric timeout keys. Explicit
  numeric timeout entries remove the warning: 45 provider tests and typecheck
  passed. Loose `as any` settings stubs allowed this mismatch; broad tests passed
  because they checked stream content, not timer validity. Other timeout fixtures
  inspected supplied numeric values or constructor defaults. No production
  watchdog policy was changed. Typed shared settings fixtures would offer wider
  prevention, but a test infrastructure refactor is not necessary for this fix.
