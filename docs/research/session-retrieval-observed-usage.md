# Session retrieval tools — observed usage and outcome study

## Status

**Open: seek/tail product decision remains unmade.** The control cell and two
labeled repair candidates have run; the tail anchor reduced the task to one
read and the numeric index to four. No API or default change has shipped.
The 2026-08-31 study included a naturalistic baseline of seven verified
sessions and 79 calls, plus six controlled continuation cells across three
rollover-versus-resume pairs, all passing their oracle — that phase closed
with no product change. Later follow-ups shipped the Pattern 1 scoping
repair and added two more naturalistic cohorts. A 2026-09-02 resume pass
re-ran the analyzer over the full local corpus (30 sessions with session-tool
calls): there were no new naturalistic sessions after the 02b cohort. The
seek/tail patterns remain over the repeat bar. The controlled cell is in
`docs/research/session-retrieval-seek-cell.md` and
`scripts/experiments/session-retrieval-seek-cell.mjs`. Its control run
required eight forward `session_read` calls to reach the final record; no
API/default/prompt change for cursors or tail access has been made.
Two more patterns (full-UUID hallucination, schema-boundary parameter
guessing) still have only single-cohort evidence.

**2026-09-02 follow-up: eleven new verified sessions, three repeated defect
patterns, still no product change.** A second naturalistic cohort of eleven
verified sessions (`2026-08-31`–`2026-09-01`, 60 calls) was added to the
corpus via `scripts/experiments/session-retrieval-followup-2026-09-02-sessions.json`
(the frozen seven-session manifest is untouched). The new cohort confirms
three previously one-off or absent patterns at scale — project-scoping
silence, cursor unreliability, and corpus-size latency — and each is now
documented below with its root cause. No API, default, budget, or prompt was
changed; the three patterns are candidate improvement targets for a future
controlled phase.
**2026-09-03 controlled repair cell: scoping defect fixed in product.** The
controlled repair cell (fixed model/effort, deterministic oracle) for the
project-scoping pattern ran to completion and the repair shipped: the browser
corpus now pins to the session's home workspace (the root the session started
in) instead of the live cwd, and every `session_list`/`search`/`read` result
surfaces an effective `scope`. The cell reproduced Pattern 1 on the
pre-repair build and showed the pinned corpus resolving the exact-ID read from
inside the worktree on the repair build. At that time cursor handles and
corpus-size latency were left open; see the 2026-09-02b follow-up and the
seek/tail cell below.

**2026-09-02 second follow-up: 7 naturalistic sessions after excluding the
scope-cell seed; cursor-invention and no-tail-pagination cross the repeat
bar; two new patterns found.** A third cohort
(`2026-09-01T12:37Z`–`2026-09-02T08:44Z`) is frozen in
`scripts/experiments/session-retrieval-followup-2026-09-02b-sessions.json`.
Rebuild with:

```bash
node scripts/experiments/session-retrieval-log-analysis.mjs \
  --sessions scripts/experiments/session-retrieval-followup-2026-09-02b-sessions.json \
  > /tmp/session-retrieval-followup-2026-09-02b-corpus.json
```

The first draft of this cohort listed 8 IDs / 102 calls. One of those IDs,
`c9dbd57e`, is the throwaway bench seed from the Pattern 1 scope cell
(`projectPath` `/home/qduc/.agents/runtime/bench-session-scope-20260902`, one
`session_search`), not a naturalistic term2 session. It is omitted from the
manifest. The remaining seven verified sessions have 101 calls: 66
`session_read`, 34 `session_search`, 1 `session_list`. A 2026-09-02 analyzer
rerun against that manifest reproduced these aggregates: execution time p90
8.1 s, max 36.0 s (`62917aa6` `session_search`); result size p50 9,365 chars,
p90 at the 12,000-char budget cap.

- **Pattern 1 (project scoping) did not reproduce.** No naturalistic session
  in this cohort entered a worktree before a session-tool call, so the
  shipped pin-to-home-workspace repair was not exercised by a scope-switch
  case. The two `not_found` results this round both trace to hallucinated IDs
  (see below), not scope. The analyzer does not read back the new `scope`
  field, so this is an absence-of-counterexample, not a direct confirmation
  the fix still holds under worktree use.
- **Pattern 2 (invented cursors) repeated.** Post-`79e7fcee` handle invention
  now has two cohorts: `6f2959a0` (`cursor: "110"`, `"c120"`) in the 2026-09-02
  follow-up, plus `d4ca2fcb` (`"55"` then `"40"`) and `e1088190` (`"0"`) here.
  The numeric guesses are not copy-corruption of a returned `c`-prefixed
  handle; they are offset-like seeks. `"55"` never reached cursor validation
  because it shipped with `limit: 80` (schema error). Rate in this cohort: 2
  `invalid_cursor` / 66 reads, plus the one schema-blocked guess.
- **No-tail-pagination repeated at scale.** `52d99eda` issued 34
  `session_read` calls: 7 budget-bound pages through 8-record session
  `85fe816a` (`omitted` 6→0, cursors `c2`→`cy`), then 27 pages through
  116-record session `e1088190` (`omitted` 112→0). `5e1b21b4` independently
  walked the same 8-record session in 8 pages. `e1088190` itself opened a
  341-record session (`07515169`) at `omitted: 339` and stopped. Forward-only
  `session_read` is the same gap noted in the first follow-up (142-record
  session, 1 record/page at default budget).
- **New pattern — full-UUID hallucination.** Session `62917aa6` called
  `session_read` with `id: "6e995939-34d9-4bed-b908-afa5c95690c9"` and
  `id: "6cd53b32-0000-0000-0000-000000000000"` — neither is a real session
  ID. Both look like spliced or half-remembered UUIDs (a correct prefix
  paired with a fabricated suffix), not a corrupted copy of a prior tool
  result. The same session also searched a third fabricated ID
  (`860f4aed-9dcd-4bed-b908-afa5c95690c9`). This is distinct from
  cursor-invention: here the primary `id` argument itself is fabricated from
  memory rather than quoted from a prior `session_list`/`session_search`
  result. Both reads returned a silent `not_found`, indistinguishable from a
  real miss.
- **New pattern — schema-boundary parameter guessing.** Twice (`d4ca2fcb`,
  `e1088190`) the model passed `maxChars` or `limit` above the documented
  maximum (`maxChars: 20000`/`16000` against the 12,000 cap; `limit: 80`
  against the 50 cap), producing a Zod validation error before any real
  result. Both times the model retried in-bounds on the next call, so the
  cost was one wasted round-trip, not a stuck failure — but the pattern
  repeated twice in one small cohort.

**2026-09-02 resume pass: no fourth naturalistic cohort.** A full-corpus
analyzer run (`node scripts/experiments/session-retrieval-log-analysis.mjs`,
30 sessions, 2026-09-02T09:04Z) found four session-tool sessions outside the
three committed/frozen manifests: two already-documented paired cells
(`01eca185`, `26f365a3`), the Pattern 1 repair cell (`0ea493f4`), and the
live study-continuation session. Nothing new to add. Cursor-invention and
no-tail-pagination therefore stay over the bar, and the next action is the
seek/tail control cell rather than more log mining.

**Bar check:** cursor-invention and no-tail-pagination have repeated evidence
across independent naturalistic sessions. That was enough to design and run
one controlled cell (see `docs/research/session-retrieval-seek-cell.md`). The
control reproduces the no-tail cost, but it is not enough to change the API:
do not ship a seek/tail/numeric-cursor repair
from these logs. The two newly observed patterns (ID hallucination,
schema-boundary guessing) still have only single-cohort evidence.

## 2026-09-02 follow-up: eleven verified sessions, 2026-08-31 → 2026-09-01

Method is unchanged from the 2026-08-31 study: `session-retrieval-log-analysis.mjs`
against the actual persisted conversation JSONL and provider-traffic index,
with every session passing all three identity checks (filename ==
`session_init.id`, first persisted user message exists, provider index preview
matches). The new manifest is
`scripts/experiments/session-retrieval-followup-2026-09-02-sessions.json`;
rebuild the follow-up corpus with:

```bash
node scripts/experiments/session-retrieval-log-analysis.mjs \
  --sessions scripts/experiments/session-retrieval-followup-2026-09-02-sessions.json \
  > /tmp/session-retrieval-followup-corpus.json
```

Eleven sessions, 60 calls: 32 `session_search`, 24 `session_read`, 4
`session_list`. Tool execution p50 8 ms, p90 6.4 s, maximum 19.9 s (vs. p50
7 ms / p90 30 ms / max 9.9 s in the seven-session baseline). Serialized result
size p50 3,672 chars, p90 10,496, max 12,000 (budget-capped). Six error
outcomes: five `invalid_cursor`, one `not_found` — plus six `session_search`
calls returning `total: 0` with zero signals that anything was wrong.

| Session | First-user-message identity | Calls | Errors | Outcome |
| --- | --- | --- | --- | --- |
| `14c52133` | safe-root-fix doc continuation (`.agents/term2` project) | 1 list, 1 read, 2 search | none | implemented Phase 1 fix; searched its own project, list showed `total: 4` |
| `2d1522b9` | find compact+rollover issue | 1 list, 2 read, 13 search | none | found coordination bug; **$2.46 retrieval turn**, 6 of 13 searches had match counts 653–6,250 |
| `341ad874` | check log for model overload error (`.agents/term2`) | 1 list, 2 search | none | agent wrote: search "hit conversation logs, not agent sessions"; pivoted to list, `total: 1` |
| `6760346e` | orchestrator: implement retry contract | 2 search | none | both searches `total: 0`; completed task from logs/memory instead |
| `6cd53b32` | rollover briefing (retro-terminal worktree) | 1 read, 2 search | 1 `not_found` | searched twice (`total: 0`), then `session_read` of the exact previous-session ID from the briefing → `not_found` |
| `6e995939` | continue after rollover request | 2 read, 1 search | none | recovered and merged the rollover guard; both pages of a long-cursor read completed |
| `6f2959a0` | check last session about incident-retro hardening | 4 read, 1 search | 2 `invalid_cursor` | guessed `cursor: "110"` and `"c120"` (no such handles); agent wrote: "Cursor tokens are opaque" |
| `9bff1663` | incident retrospective (codex) | 2 search | none | both searches `total: 0`; worked from memory instead |
| `ad879de3` | upstream-error-retry doc continuation | 6 read, 2 search | 3 `invalid_cursor` | mangled the long base64 cursor twice (e.g. `nexhxTextOfFsx`), dropped `id` once; re-read from scratch |
| `b6efa566` | "explain the session tools" (tool evaluation, like `6b120f67`) | 1 list, 5 read, 3 search | none | deliberate boundary testing; 1-item page and 11 s cursor page observed |
| `ccf9f945` | restart/reproduce reliability lanes | 3 read, 2 search | none | clean recovery: read three exact-ID sessions in one page each |

### Pattern 1 — project scoping silently empties the browser (6 zero-hit searches + 1 `not_found`)

All six `total: 0` searches and the one `not_found` across `6760346e`,
`6cd53b32`, and `9bff1663` share one root cause: the browser resolves its
corpus from `executionContext.getCwd()` **at call time**, and all three
sessions had run `enter_worktree` before searching. `browseConversationsForProject`
keeps only conversations whose persisted `projectPath` equals the caller's
cwd, so after entering a worktree the browser sees only conversations logged
in that worktree directory — usually zero. `session_search` then returns
`total: 0` with `unavailable: 0`, and `session_read` of a main-checkout
session ID returns `not_found` (project mismatch is folded into `not_found`
in `loadConversationForProjectReadOnly`). Nothing in any result signals that
the scope changed. The repro (`SessionBrowser` constructed with the worktree
path finds the same transcripts fine) confirms the data is present and the
failure is purely scoping.

This is the strongest new finding: three independent sessions were silently
blinded to the entire transcript history, and two of them were the most
retrieval-dependent (an incident retrospective and its rollover continuation
— the exact-ID read the rollover briefing told the agent to make failed).

### Pattern 2 — cursor failure modes changed but did not disappear

The 2026-08-31 short-cursor fix (`79e7fcee`) replaced long self-contained
base64url cursors with process-local `c1`-style handles. The new cohort
shows both regimes:

- `ad879de3` ran pre-fix: the model corrupted the long base64 cursor twice
  (transcribed `nextTextOffset` as `nexhxTextOfFsx`), dropped `id` once,
  and got `invalid_cursor` three times before re-reading from scratch.
- `6f2959a0` ran post-fix: the model **invented** `cursor: "110"` and
  `cursor: "c120"` instead of copying the returned handle, earning two
  `invalid_cursor` errors, and wrote "Cursor tokens are opaque; let me walk
  forward from `c2`".

The fix removed copy-corruption but left an opaque handle the model reasons
about as if it were an offset. Five `invalid_cursor` outcomes in 24 reads is
21% read failure across the cohort.

### Pattern 3 — corpus-size latency

Execution time went from a p90 of 30 ms (seven-session baseline, small
corpus) to a p90 of 6.4 s and a max of 19.9 s. `list`/`search` re-scan and
re-project every `.jsonl` in the project directory on every call (203 files
at time of writing); the slow tail is local scanning, not provider latency.
Seven calls exceeded one second, all in the `/home/qduc/term2` project. The
2026-08-31 baseline measured the same mechanism at small corpus scale; the
new cohort shows it is a real scaling problem at current corpus size.

### What the cohort confirms is already good

- **Exact-ID reads with adequate budget are reliable and cheap.**
  `ccf9f945` recovered three sessions in one page each; `6e995939` paged a
  83-record session with a correctly copied cursor.
- **Search match counts and budgets behave as documented.** No
  `output_budget_exceeded`, no stale cursors in the new cohort; result sizes
  respect `maxChars`.
- **The live-session demotion works.** The five `total: 0` searches that
  would have self-matched the query were not polluted by the live session.

### What the cohort confirms is not good

- **Silent project re-scoping** (Pattern 1) is a defect, not a tuning
  question: the agent cannot see that its corpus just became empty.
- **Cursor handles are the wrong abstraction for small models** (Pattern 2):
  opaque tokens get invented when not copied verbatim.
- **No-pagination access to the tail of a long session.** `session_read`
  walks from the start; the 142-record incident session returned one record
  per page at default budgets (observed in `6f2959a0`/`b6efa566`).
- **Tool-kind matches crowd out conversation matches** (`341ad874` explicitly
  complained; `2d1522b9`'s broad searches returned thousands of matches
  dominated by command output).
- **Broad browsing is expensive.** `2d1522b9` spent $2.46 in its
  retrieval-bearing turn on 16 calls, six of them searches with match counts
  in the hundreds to thousands.

### Follow-up decision

The acceptance bar from the 2026-08-31 study is unchanged: no API/default/
prompt change from naturalistic logs alone. But the bar has now been met for
the *scoping* pattern — it is a silent correctness failure in three
independent sessions, not a quality variance — so the next step was a
controlled repair cell (fixed model/effort, deterministic oracle) that
verifies the browser either (a) pins its corpus to the session's home
project rather than the live cwd, or (b) surfaces the effective scope in
`list`/`search`/`read` results so a `total: 0` is distinguishable from a
scope switch.

**Repair cell result (2026-09-03).** The cell ran on `codex/gpt-5.6-luna`
(medium) in a throwaway bench repo at
`/home/qduc/.agents/runtime/bench-session-scope-20260902` with a deterministic
two-message protocol: (1) create and `enter_worktree` a worktree of the bench
repo, (2) recover a token that exists only in a seed session's transcript
(via the session tools) while inside the worktree, then fix a failing
`node --test` fixture and commit with the token as message suffix. The oracle
required the recovered token in the final answer.

- **Control (current build at the time):** session `4aec6622`. Inside the
  worktree, `session_search` → `total: 0`, `session_read <seed>` →
  `not_found` (opaque), `session_list` → `total: 0`, `session_search` →
  `total: 0` — Pattern 1 reproduced, with no scope signal in any result. The
  agent recovered only by `exit_worktree` (returning to the home root),
  reading the seed there, re-entering the worktree, and completing the fix.
  Oracle passed via the workaround; the defect was exposed as silent
  empty-corpus results and two extra round-trips.
- **Repair (pinned corpus + scope field):** session `0ea493f4`. Inside the
  worktree, a single `session_read <seed>` returned the transcript (with the
  new `"scope"` field), the agent fixed the fixture, committed with the
  token, and reported it. Oracle passed with no workaround.

Both cells passed their oracle (the agent is capable of recovering), so the
outcome is not a quality verdict — it is the controlled counterfactual that
the scoping pattern is a real, isolated defect and that pinning the corpus to
the session's home workspace removes the failure mode the naturalistic
sessions hit. The shipped repair implements (a) and (b) together: the browser
pins to `executionContext.getHomeWorkspace()` and every result carries
`scope`. The driver and replay instructions are in
`scripts/experiments/session-retrieval-scope-cell.mjs`; raw cell transcripts
are preserved under the bench dir's `raw-cells/` (local user state, not
committed).

Cursor-invention and no-tail-pagination now have that repeated case; the
seek/tail control cell is the counterfactual. Corpus-size latency is still
only a scaling observation (no cell). An in-progress local worktree
`.worktrees/session-read-pagination-cache` is a list/read snapshot cache,
not a seek/tail API, and is not part of this study.

The acceptance bar remains the one in
`docs/plans/session-rollover-handoff.md`: multiple task shapes, both rollover
and ordinary-resume flows, outcome evidence, and concrete failure cases before
any tuning proposal is accepted.

## Resume checklist ("audit the session tools again")

When asked to revisit this study, do not re-derive the method — extend it:

1. If the seek/tail control cell has not been run, run it before mining more
   logs. Protocol: `docs/research/session-retrieval-seek-cell.md`. Driver:
   `scripts/experiments/session-retrieval-seek-cell.mjs`. Do not implement a
   product repair until that control reproduces the page-walk / invented-cursor
   shape against the current build.
2. Add newly verified *naturalistic* sessions to a new dated follow-up
   manifest (do not edit the frozen baseline, 2026-09-02, or 2026-09-02b
   lists). Exclude live sessions, paired-protocol cells, and bench-project
   seeds. Verify the same way: filename == `session_init.id`, a first persisted
   user message exists, and it matches the provider-traffic index's
   `firstUserMessagePreview`.
3. Rerun `scripts/experiments/session-retrieval-log-analysis.mjs` against the
   new manifest and diff the aggregate stats (call-type mix, latency,
   result-size distribution) against the numbers in this file.
4. Check specifically whether any pattern that is still *single-cohort*
   (full-UUID hallucination, schema-boundary guessing) or listed under "What
   this baseline cannot establish" now repeats across independent sessions.
   Cursor-invention and no-tail-pagination already crossed that bar.
5. Do not propose an API/default/prompt change from naturalistic logs alone —
   that was the rule that closed this study without a change the first time,
   and it still applies to every pattern except Pattern 1 (already repaired
   via a controlled cell).

## Method

`scripts/experiments/session-retrieval-log-analysis.mjs` scans the actual
persisted conversation JSONL and provider-traffic index. It does not assign a
session by wall-clock window. A session enters this corpus only when:

1. the conversation filename matches its `session_init.id`;
2. the first persisted `user_message` exists; and
3. the provider-traffic index entry for that exact session ID has a matching
   `firstUserMessagePreview`.

The analyzer records ordered tool calls and arguments from `tool_started`,
results from `command_message`, per-call execution time between those two
events, bounded result size and diagnostics, retrieval-bearing turn cost from
`assistant_turn.costRecords`, and whole-session provider elapsed time. The gap
between a provider response containing the tool call and the next provider
request is also recorded, but it is a continuation-gap proxy: it includes local
dispatch, other parallel tools, and application scheduling, so it is not
reported as session-tool execution latency.

The raw corpus is local user state and is intentionally not committed. Rebuild
it with:

```bash
node scripts/experiments/session-retrieval-log-analysis.mjs \
  --sessions scripts/experiments/session-retrieval-baseline-sessions.json \
  > /tmp/session-retrieval-corpus.json
```

The explicit session manifest freezes the seven-session naturalistic cohort.
Without it, the analyzer intentionally scans every session containing a session
tool call, including the later controlled rollover cells.

## Naturalistic baseline

All seven session IDs below were verified against their first user message.

| Flow | Session ID | First-user-message identity | Calls | Retrieval-bearing turn outcome |
| --- | --- | --- | ---: | --- |
| ordinary continuation | `10c85a17-d2e1-4622-be16-f284a1201244` | “what were we doing” | 1 list, 1 read | Correctly recovered the memory/session-browser implementation state in one turn; 14 s from first retrieval to answer, $0.0074 |
| rollover continuation | `3e3c61f8-d7a2-431e-a4cd-b929a85e3289` | WebSocket lifetime handoff | 2 searches across two turns | Hidden evaluator PASS 8/8 and blind-judge human parity; no list/read; whole continuation $0.0964 |
| ordinary continuation | `53c3d897-64b3-4ad7-93dd-921e0df31f2e` | find and continue model-effort step-down work | 12 searches, 3 reads, 1 list | Recovered the experiment, resumed it, and produced the later benchmark decisions; retrieval-bearing turn 526 s, $0.0245 |
| tool evaluation, excluded from natural outcome comparison | `6b120f67-cbe6-43de-9b3b-c910c13e3a55` | “use the session tools and give me feedback” | 7 searches, 9 reads, 2 lists | Deliberately exercised success/error/budget boundaries; useful for API diagnostics, not agent browsing efficiency |
| live-session recovery edge case | `bd841e1a-1cd0-49ef-8f28-d73e7b094793` | inspect/fix CI failure | 3 searches, 6 reads, 2 lists | Eventually recovered the correct CI state, but retried mistyped IDs and read its own changing session |
| ordinary continuation | `c18e441f-8f56-47e3-b392-a97c35284c32` | interrupted Librarian experiment | 11 searches, 9 reads | Retrieval was necessary and the continuation completed the experiment, but it took 1,609 s and $0.2312 in the retrieval-bearing turn |
| live-session review edge case | `ea6a8471-c360-4d95-af8b-9eaad2a73102` | mode-switching implementation | 8 searches, 2 reads | Used browsing to reconstruct earlier review claims; one self-read cursor went stale |

Aggregate across the seven sessions:

- 79 calls: 43 `session_search`, 30 `session_read`, 6 `session_list`.
- Tool execution time: p50 7 ms, p90 30 ms, maximum 9.86 s. The slow tail is
  real local scanning over a large transcript corpus, not provider latency.
- Serialized result size: p50 3,364 chars, p90 10,763, maximum 11,999. 22/79
  results were at least 8,000 chars and 7/79 were at least 11,000.
- Provider continuation-gap proxy: p50 7.8 s, p90 73.3 s. This is not pure
  tool latency and must not be used to tune the local implementation.

## What the observed agents actually did

### Efficient and necessary retrieval

The vague “what were we doing” continuation used the expected progressive
disclosure path: one 10-item `session_list`, then one 50-record
`session_read` of the identifiable previous session. It returned a correct
state report without a search or a second page. Here `session_list` changed the
outcome: the prompt contained no searchable task noun or session ID.

The interrupted Librarian continuation also needed old-session evidence: its
first prompt named only the role and a harness interruption. It ultimately
found the original experiment session and completed the implementation and
evaluation. Retrieval therefore changed correctness, but the path was costly:
20 calls, including repeated reads and searches over substantially overlapping
phrases.

### Unnecessary retrieval under a strong handoff

The rollover WebSocket task had a diagnosis-rich handoff. Its first search —
`responses-websocket-sessions _onError unhandled promise rejection idle
socket` with a 3,000-char budget — repeated facts already present in the
brief. It returned five matches but did not supply a missing load-bearing fact.
The later targeted search — `session lifetime worktree commits`, limit 3,
1,200 chars — was useful for recovering durable commit/worktree state. This is
a concrete mixed case: one likely redundant search and one useful targeted
search, still with no transcript paging.

### Insufficient or unstable retrieval

The naturalistic corpus contains concrete failures rather than only successful
examples:

- The CI recovery session attempted three mistyped variants of its own session
  ID before using the exact ID.
- Completed and live-session reads produced `invalid_cursor` and
  `stale_cursor` outcomes. Three such cursor failures occurred in the
  Librarian continuation alone; self-reading a session while it changes is a
  reproducible stale-cursor pattern.
- The model-effort continuation issued broad queries whose match counts reached
  hundreds or thousands, then used near-default maximum outputs. It recovered
  the work, but several searches were reformulations over the same experiment
  and one copied cursor was invalid.
- The explicit tool-evaluation session confirmed the bounded
  `output_budget_exceeded`, `not_found`, and stale-cursor errors. Those calls
  are excluded from natural efficiency rates because they were requested test
  cases.

### Budget behavior

Agents frequently selected `limit: 20–50` and `maxChars: 10,000–12,000` when a
brief did not identify one exact target. The output distribution confirms that
these were not inert maxima: 28% of observed results exceeded 8,000 chars.
That is evidence of broad browsing, but not yet evidence that the defaults are
wrong. The corpus lacks the counterfactual showing whether a smaller result
would preserve outcome quality.

## What this baseline cannot establish

The sessions differ in task, model, prompt quality, and amount of durable state.
Their retrieval-bearing turn cost includes all model and coding work in that
turn, not an isolated price for retrieval. Natural logs can identify useful,
redundant, and failed calls, but cannot prove whether a different API/default
would improve the same continuation. In particular, there is only one genuine
rollover task in the baseline.

Therefore this baseline is enough to choose the controlled experiment, not to
change the tools.

## Controlled paired phase

The protocol design, source boundaries, prompt content, fixture facts,
project-path caveat, and replay command are archived in
`docs/research/session-retrieval-paired-protocol.md`. The exact-ID manifest is
`scripts/experiments/session-retrieval-paired-runs.json`; the analyzer is
`scripts/experiments/session-retrieval-paired-analysis.mjs`.

All cells ran serially in real interactive term2/Herdr with
`codex/gpt-5.6-luna` at medium effort. Each pair held model, effort, and source
state fixed:

1. **Diagnosis-rich coding handoff** — old transcript mostly unnecessary;
   verifies whether rollover avoids browsing and retains deterministic coding
   correctness.
2. **Interrupted experiment/research workflow** — decisive state is split
   between transcript and durable artifacts; tests query quality,
   reformulation, and selective reads.
3. **Sparse operational continuation** — the continuation instruction supplies
   almost no searchable vocabulary; tests whether the bounded rollover's exact
   previous-session ID is enough for selective recovery.

For every task, the comparison was:

- **ordinary resume:** restore the source session through the product's resume
  path, then issue the continuation instruction;
- **rollover:** start a fresh interactive root session with a bounded handoff,
  previous-session ID, and the existing session tools.

The interactive root path was required because non-interactive term2
intentionally does not register `SessionBrowser`. Every result below passed all
three identity checks: conversation filename equals `session_init.id`, a first
persisted user message exists, and the provider index's preview matches that
message. Cost and traffic were sliced from the exact continuation user event,
not a wall-clock attribution window.

The resulting cells were:

| Task | Flow | Result session ID | Session calls | Requests | Elapsed | Tokens | Cost | Outcome |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| diagnosis-rich coding | rollover | `296b1363-dd2d-4d8e-b306-b1e057de3a02` | none | 21 | 220.5 s | 811,302 | $0.0347 | hidden evaluator PASS 9/9 + typecheck |
| diagnosis-rich coding | ordinary resume | `9cc61896-a75e-4af9-b1bb-c4f6c432a75c` | none | 17 | 136.4 s | 1,233,639 | $0.0431 | hidden evaluator PASS 9/9 + typecheck |
| interrupted research | rollover | `01eca185-0682-40c6-a25f-cd4377f92f5a` | 1 search, 1 read | 5 | 23.4 s | 69,053 | $0.0049 | checklist PASS |
| interrupted research | ordinary resume | `b9ba496e-e3ba-4c43-b026-dbb50196e55f` | none | 1 | 8.6 s | 13,401 | $0.0010 | checklist PASS |
| sparse operational | rollover | `26f365a3-4255-4a02-99a1-86a855eeba88` | 1 read | 2 | 9.3 s | 25,156 | $0.0033 | checklist PASS |
| sparse operational | ordinary resume | `8b8d3860-7d3c-4104-8d11-ab206bbb2426` | none | 1 | 4.8 s | 12,848 | $0.0007 | checklist PASS |

`Tokens` is provider-reported total input plus output for the continuation and
includes cached input. Source-session work is excluded. Ordinary resume reuses
the source session ID, so its first-message verification correctly checks the
source's first prompt rather than the later continuation prompt.

### Ordered retrieval evidence

The coding handoff was self-sufficient: both cells made zero session calls and
passed the same hidden evaluator. The rollover used fewer tokens and cost less,
but took longer and made more requests; this pair supports handoff
self-sufficiency, not a universal rollover performance advantage. Its two
isolated coding trees had different project paths, so the rollover browser
could not have read the project-scoped source transcript if the handoff had
failed.

The interrupted-research rollover made two calls in order:

1. `session_search` with query
   `acceptance rule routing versus prompt distinction retrieval desired-behavior invocation coding oracle`,
   `limit: 10`, `maxChars: 6000`; 4 ms, 2,563 characters, six results.
2. `session_read` of the exact source ID, `cursor: null`, `limit: 12`,
   `maxChars: 10000`; 4 ms, 3,941 characters, six records.

The read supplied the transcript-only acceptance rule and scope distinction and
was necessary. The preceding search was redundant: the rollover brief already
provided the exact source ID and named the missing facts. There were no errors,
retries, reformulations, omitted records, or cursor failures.

The sparse-operational rollover directly called `session_read` on the source
ID with `cursor: null`, `limit: 20`, and `maxChars: 12000`; it returned all five
records in 2,696 characters in 5 ms. That one read was necessary and sufficient.
There was no list, search, retry, reformulation, omission, or error. The ordinary
resume needed no retrieval because the original transcript was restored.

### Decision

The controlled phase confirms the existing routing can complete all three task
shapes. It also supplies a concrete avoidable-search case, but not a repeatable
failure that justifies changing product routing: the other retrieval-dependent
rollover used the exact-ID read directly, and the strong coding handoff used no
retrieval. Local tool execution remained 4–5 ms; the material cost came from an
extra model continuation, not local scanning.

Therefore retain the current APIs, defaults, budgets, and prompt. A future
candidate may test an explicit “when a rollover gives an exact previous-session
ID, read it directly before searching” routing instruction, but it should be a
controlled prompt counterfactual with missed-history checks—not an inference
shipped from this one redundant search. The naturalistic broad-output and stale
self-cursor cases remain diagnostics, not established default defects.

The study collected per cell:

- ordered session-tool calls and full arguments;
- result sizes, errors, omitted counts, execution latency, retries, and query
  reformulations;
- whether each retrieval supplied a fact used in the successful outcome;
- deterministic evaluator/checklist result and any missed-history failure;
- retrieval-bearing turn and whole-continuation requests, tokens, elapsed time,
  and cost.

All three pairs are settled. The report now contains baseline distributions,
necessary and redundant calls, cursor/error failure cases, and controlled
counterfactual outcomes. The done condition is met without a product change.

