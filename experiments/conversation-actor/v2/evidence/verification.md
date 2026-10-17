# Verification of the second design iteration

Scope: standalone fake-port model plus a proposed production ownership map.
Production runtime code and the original experiment remain unchanged. See
`commands.json` for executed commands, return codes, and source hashes; the adjacent
logs retain their output. `review.md` records independent behavioral review;
`readback.md` records the fresh-reader explanation check and its limits.

Claims and evidence:

- Result knowledge is separate from stop evidence. Named scenarios cover both
  arrival orders, cancellation, connection loss, duplicate facts and two rollovers.
- A cancelled turn cannot advance from late output; replacement remains queued
  until retired executions stop. Independent review exercises 24 race permutations,
  synchronous stop-first ports and reentrant observers.
- Known tool outcomes received before cancellation survive transcript repair.
  `known-result-before.log` is the named scenario with only that fix reverted;
  `known-result-after.log` is the same scenario against the final implementation.
- All 26 scenarios run individually and together. Two full event traces are byte
  identical. The original 20-scenario v1 still runs unchanged.
- Focused and root typechecking, root lint, static guards and no-unit-tests policy
  check are recorded separately. These are static evidence, not production parity.
- The short page gives one place to locate six reader questions. The fresh reader
  identified three explanatory omissions; the recheck confirms the revised rules.
  This is a proxy with an already primed reviewer, not human comprehension proof.

The second actor is 495 physical lines versus v1's 394. Added physical-lifetime
knowledge costs code. No production line-count reduction is claimed. The design
reduces independent lifecycle decisions; it does not make operational guarantees
free. The deletion map names contracts that each production cut must preserve.

## Review defect and prevention

Preventable: yes. A known result arriving before stop was a supported order, but
cancellation still used v1's blanket unknown settlement. Origin: introduced in this
uncommitted v2 iteration. The new execution registry held knowledge that the old
terminal-repair path ignored; the first 25 scenarios checked the stop barrier but
not preservation of the result value at that boundary.

Fix: terminal repair reads the matching execution's existing result; no second
cache, state flag or lifecycle owner was added. Regression: the same named CLI
scenario fails with the fix reverted and passes after. Sibling audit: normal live
foreground settlement already reads that result; background completion projects
its outcome; rollover intentionally replaces context; model output after revocation
stays excluded. Independent race probes cover result before/after revocation.

Structural artifact: `execution-result` now retains the copied fact in the event
journal rather than only its kind, making pre-stop knowledge inspectable after
release. The short design and detailed guard contract explicitly require retaining
known pre-revocation outcomes. Production persistence/projection is still a separate
proof obligation, not supplied by this in-memory event log.

## Uncertain

No real provider/process stop evidence, durability, streaming, compaction, rich
payload or gateway lease migration, production retained-pause policy, transfer of
an already running execution, measured human comprehension, or production parity
is demonstrated. The recommended next cut is submission ownership as a whole;
production acceptance must exercise the existing user workflows and contracts.
