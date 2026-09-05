# Bug: `session_read` cannot read the tail of a transcript, and its `from: "end"` contract promises a cursor it never returns

**Status:** partially resolved (2026-09-05). The tail/page contract findings are fixed by the M2a repair in commit `569f9e3b` (see Resolution below); the rollover successor/brief delivery finding remains open.
**Severity:** medium — no data loss, but it breaks the tool's primary purpose
("continue from previous session") for long transcripts, and the description
actively instructs the model down a path that dead-ends. Workarounds exist but
cost a full forward walk or a fallback to `session_search` + durable files.
**Component:** `source/services/conversation/session-browser.ts` (`#read`,
`#cursorFor`), `source/tools/session-browser/session-browser-tools.ts`
(`session_read` description).
**Observed:** 2026-09-05, resuming session `64982f3b` (290 records). All
probes below were run against the live tool in this session, not inferred.

## Resolution (2026-09-05, M2a)

Fixed for the canonical browser (`SessionBrowser.read` in `source/services/conversation/session-browser.ts`, branch `sqi-m2a`, commit `569f9e3b`; contract in `docs/plans/session-query-index.md`, "Tail and page contract repair"):

- **Tail anchor (symptom 1 and the `tail`-shape finding's core need).** An initial `from: "end"` read now starts at projected ordinal `max(0, total - effectiveLimit)` and returns that region chronologically; the existing forward cursor pages through the region (chunk continuations included) and disappears once it is consumed. Last-N access needs no new parameter. The report's "no cursor is ever returned" claim was too broad — an oversized final record already returned chunk cursors — but the final-record anchor still made every other tail record unreachable, which was the real defect.
- **`omitted` accounting (symptom 3).** `read` now reports page-local counts: `omitted = total - items.length`, so `total - omitted` equals records represented on the page on every page shape, including partial and resumed chunks. The old calculation measured cumulative remaining records and disagreed with the description on continuation pages.
- **Description alignment.** The `session_read` description, its test pins, and the `session-browser.md` prompt fragment now state the region anchor, `maxChars`-driven continuations, cursor-only-while-forward-content-remains, and that read `omitted` covers records absent for any reason (before the anchor, beyond `limit`, awaiting continuation) — unlike `session_list`/`session_search`, where `omitted` still counts only budget-dropped entries.

Still tracked in this report, not addressed by the tail repair:

- **Rollover successor/brief delivery** remains unobservable. The plan scopes brief persistence, projection, and successor delivery outside the index and tail contract, so a full tail read still proves nothing about a missing successor; this finding stays open here.
- **Per-message time filtering** (the session-level `updatedAt` finding) is out of the current API scope; M2a only documented the session-level meaning in the `session_search` description.

## Symptom

Resuming a predecessor whose final act was `session_rollover` needs the last
few records (the handoff brief is a tool-call parameter in them). Three
failures combine:

1. **`from: "end"` reads exactly one record and returns no `nextCursor`.**

       session_read({ id, from: "end", limit: 10, maxChars: 512 })
       → items: [index 289], total: 290, omitted: 0, no nextCursor

   Limits of 5, 10, and 20 all return the single final record. The tool
   description says: *"omit `cursor` with this option, then use the returned
   cursor for any continuation"* — but no cursor is ever returned, because
   `#read` starts at `records.length - 1` and a cursor is only produced when
   `afterIndex < projection.records.length`. The instruction is
   unfulfillable by construction. Verified against the live tool and in
   `session-browser.ts` (`nextIndex: input.from === 'end' ? Math.max(0,
   projection.records.length - 1) : 0`).

2. **There is no reverse paging.** Cursors only move forward (`index + 1`);
   nothing in the input schema or service can page from record 289 toward 240.
   The tail of a long transcript is reachable only by walking forward from
   record 0 in ≥6 pages (the minimum `maxChars` is 512), which the model in a
   real run will often not do — in the observed run it gave up and reconstructed
   state from `session_search` snippets, missing the rollover brief entirely.

3. **`omitted: 0` on the end read contradicts the documented meaning.** The
   description defines `omitted` so that *"`total - omitted` records were
   started here"* — the end read reports `total: 290, omitted: 0`, implying all
   290 records started, when 1 was shown. (An initial forward read is correct:
   `total: 290, omitted: 289`.) In `#read` the payload carries `omitted: total`
   on the first fitted page; whatever adjustment produces 0 here, the end
   result misleads a reader into believing the read was complete.

## What was ruled out

- **Initial forward reads work.** `session_read({ id, limit: 3, maxChars: 512 })`
  returns record 0 with a valid `nextCursor` and `omitted: 289`. An earlier
  draft of this report claimed silent-empty initial reads; that was an error in
  the caller's `run_code` return projection, not the tool.
- **`id: "previous"` and UUID-prefix resolution** worked throughout.

## Related findings from the same run (smaller, same theme: contract lies to the model)

- **`session_read` has no `tail` parameter.** `session_read({ id, tail: 30 })`
  is rejected (`Unrecognized key`). Tail-of-transcript is the single most
  common read for session continuation and is the one shape the tool cannot
  express.
- **`session_search` item `updatedAt` is session-level, not item-level.** Every
  hit for a session shows that session's last-write timestamp, so results
  cannot be ordered or bounded by when they happened. Callers then over-read.
- **`session_rollover` brief delivery is not observable.** The predecessor
  requested a rollover at 13:03 (`status=rollover_requested`); no successor
  carrying that brief materialized — the next session began from a plain user
  message 26 minutes later, and the brief is unrecoverable by any tool. Either
  the rollover failed silently or its successor is invisible to
  `session_list`. A requested rollover should deliver the brief as the
  successor's first message or report failure.

## Suggested direction

1. Honor the documented contract: make `from: "end"` a *starting region*, not
   the final record — e.g. start at `max(0, length - limit)` and return a
   `nextCursor` whenever records remain (forward or, better, introduce
   backward paging via a `before` cursor).
2. Fix the `omitted` accounting so `total - omitted` equals records started on
   every page shape, and add a test asserting it for the `from: "end"` read.
3. Align the description with behavior (or the behavior with the description —
   today they disagree, and the description is what the model acts on).
4. Consider a `tail`-shaped convenience read; the continuation flow wants
   "last N records" more often than "record 0 onward".
