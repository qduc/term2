# Session search stalls and Codex reconnect repair

Investigation and local workflow verification: 2026-10-05. Source baseline:
`efeda93a`; repair branch: `codex/session-search-reconnect`. Measurements used
Node 24.19.0 on the development Linux machine and an isolated copy of the local
session index. Live conversation logs and provider credentials were not modified.

## Evidence and repair

The October 3–4 provider traffic contained 49 `Invalid previous_response_id`
failures across ten sessions. Every rejected anchor matched an earlier successful
response with the same model and logical history key, but a different physical
WebSocket connection. Socket replacement was confirmed; its original closure
cause was not retained. Most observed leases were younger than the lifetime cap.

`CodexResponsesWSModel.#onConnectionAcquired` now compares the acquired lease
with its logical history's connection before dispatch. A replacement rejects a
chained delta locally with `previous_response_not_found`.
`CodexResponsesTransport.fetchResponse` records unsent dispatch and releases the
lease for recovery. Complete-history provider fallback remains local; caller
deltas and completed tool continuations use existing bounded application chain
recovery. Retained sockets still chain. A zero-retry setting remains authoritative.

The original `session_search` query was `No healthy model in agent.balancedModel
pool`, `kinds: ['tool']`, `limit: 5`, `maxChars: 7000`. Its recorded invocation
took 149,353 ms despite a 120,000 ms outer deadline. Short OR term `No` expanded
the copied index search to 70,379 matching records, approximately 227 million
source characters. SQL candidate selection took about 0.73 seconds.

`matchCenteredSnippet` enumerated every occurrence and searched a complete
lowercase/source boundary array for each occurrence. It now checks the first
occurrence per term, uses direct ASCII offsets, and maps Unicode offsets only
through a first match. Lowercase expansion and surrogate safety remain covered.
This shared fix also covers memory search.

An unavailable index previously made `SessionBrowser` repeat canonical JSONL
parsing/search synchronously on the UI thread. Indexed browsing now delegates
canonical list, search, and read to a dedicated worker. Fallback read cursors
stay in that worker after index recovery; opaque `f` handles do not collide with
indexed `c` handles. The loader resolves `jiti` from the installed app rather
than the user's project directory. Explicit synchronous canonical callers keep
their existing API.

## Real-use verification

- The copied 1.1 GB index completed the original worker query in 3,035 ms;
  pre-fix it exceeded 10,000 ms. Through `SessionBrowser`, five results from
  48,802 tool matches returned in 2,634 ms. A 10 ms main-thread interval kept
  running: 249 ticks, largest gap 114 ms.
- A 63 KB repetitive canonical fallback output delayed a 10 ms timer to 808 ms
  before repair. After repair it fired at 18 ms; search completed in 473 ms.
  These measure event-loop responsiveness, not terminal frame rate.
- A 288 KB repetitive snippet went from 36,715 ms to 0.60 ms in the local probe.
- Shipped `dist/cli.js`, isolated settings, loopback Responses server, real PTY:
  two user turns across socket replacement completed with two sockets, no stale
  anchor, and the first turn retained in the second request.
- An approved `pwd` workflow preserved one completed call/result pair in a
  self-contained continuation after the producing socket was replaced.
- Shipped CLI `run_code → session_search` searched a 72 KB saved tool output
  with a deliberately invalid optional index and returned to the composer. This
  exposed and verified the loader's cwd-independent resolution fix.

The three added CLI scenarios passed together: 17.09 seconds, exit 0, 90-second
command limit. Existing approval frames still exercise split arguments. Unit
contracts also verify no caller-thread JSONL reads during fallback list/search/
paged read and no stale delta dispatch. Temporary local probes were
`/tmp/term2-log-fixed.cjs` (`snippet`, `freeze`, `worker-search`) and
`/tmp/term2-index-browser-heartbeat.cjs`; each used a finite 30–45 second limit.

## Defect-class retrospective

The violated boundaries were physical socket ownership of Codex anchors and CPU
ownership of optional-index fallback. Bounded output was mistaken for bounded
work: a 240-character snippet still inspected thousands of occurrences. Snippet
cost was latent in `dbdb38bd` (bounded retrieval introduction); cwd-relative
loader resolution was latent in `5a67cada` (worker introduction). Logical Codex
history recovery in `669f2d7f` retained continuity without a physical binding.

Existing snippet tests used small Unicode examples. Model tests mocked away the
pool; pool tests omitted model history. Worker tests ran from the repo, where
cwd-relative dependency lookup succeeded. These were cross-boundary detection
gaps. New structural contracts check one probe per term, compose the real pool
with model history, assert fallback file-I/O ownership, and launch the shipped
CLI from a fresh project. Type checking cannot establish CPU complexity or
server anchor lifetime.

Sibling audit: canonical session search, indexed search, and memory search all
use the repaired helper. List/read fallback moved with search. The only other
cwd-relative `require('jiti')` is a test-owned worker fixture in
`session-index-concurrency.integration.test.ts`, running from the repo. OpenAI
persisted response history has a different contract; admission is Codex-specific.

Prevention is executable boundary coverage, rather than avoiding short words or
raising deadlines. Existing connection diagnostics made all 49 failures
traceable; retaining socket-close causes would improve attribution. Exact
production onset and original CI outcomes are not established.

Remaining limits: request timeout still does not cancel running worker CPU work;
canonical browsing can remain expensive on very large corpora. Search transfers
and final sorting can briefly occupy the main thread (114 ms here). No live
provider canary, terminal frame profiling, or deadline/retry tuning is claimed.

## Validation

Focused six-file regression run: 151 tests, 9.66 seconds, exit 0. Related run:
198 files, 4,686 passed tests, two expected failures and one skipped test,
110.69 seconds, exit 0 (300-second limit). Type checking and build passed.
Broad gates passed with finite command limits:

- Unit: 702 files; 10,847 passed, three expected failures, two skipped;
  215.08 seconds, exit 0 (600-second limit).
- Integration: 12 files passed, one skipped; 106 passed tests, one skipped;
  42.28 seconds, exit 0 (300-second limit).
- Provider black box: 20 files, 181 passed tests, one skipped;
  115.10 seconds, exit 0 (600-second limit).
- Codex network e2e: 16 passed tests; 1.40 seconds, exit 0
  (90-second limit). Includes retained-socket server rejection as well as local
  reconnect admission, and ambiguous-dispatch recovery.
- Final type check passed, exit 0 (90-second limit).
- Changed-code handoff: 198 files; 4,686 passed, two expected failures,
  one skipped; 94.47 seconds, exit 0 (300-second limit), run alone.
- Scoped ESLint passed with zero errors; the four changed script fixtures are
  ignored by the repository's existing lint configuration. Changed TypeScript
  files were formatted; `git diff --check` passed.

The first broad provider run exposed an old fixture that closed every socket
while expecting continued chaining. The first network e2e run similarly sent
unowned anchors on fresh sockets. Fixtures now distinguish retained sockets,
replacement, and native server rejection. Their corrected gates passed above.
The first changed-code gate overlapped the provider gate and one synchronous
canonical tail-read fixture exceeded its 10-second test deadline. The isolated
case passed in 1.17 seconds; the complete changed-code gate was rerun alone.

## Prevention checklist

1. Representability: logical anchors remain representable after pool replacement;
   acquisition now checks the physical owner before any frame is sent.
2. Single source of truth: acquisition metadata owns the live socket identity;
   the model records which connection its logical history used.
3. Boundary contract: model/pool admission and main-thread/worker file ownership
   now have executable coverage.
4. Implicit coupling: recovery preserves the application's durable call/result
   pairs; a transport cannot turn a caller delta into full history itself.
5. Wrong assumptions: logical affinity does not promise physical continuity,
   bounded output does not bound CPU cost, and project cwd does not own app deps.
6. Detection gap: pool mocking, small snippet inputs, and repo-local worker tests
   hid these boundaries; real CLI fixtures now cross them.
7. Automation gap: structural complexity assertions and real worker/CLI checks
   catch failures that types alone cannot establish.
8. Sibling paths: session/memory snippet callers and list/read fallback were
   checked and repaired; persisted OpenAI history keeps its separate contract.
9. Knowledge gap: physical store:false anchor lifetime was not enforced where
   the acquired lease meets the model's chain state. The admission guard now
   states that invariant where it can be checked.
10. Observability: connection metadata established replacement; closure causes
    and exact production onset remain unknown. UI evidence measures timer gaps.
11. Origin: the latent snippet and worker-loader defects and logical-history
    origin are identified above; historical CI outcomes were not established.
