# run_code authoring friction: return contracts, serialization, and schema errors

## Resume here

**Status: COMPLETE (2026-09-06).** M1 merged (`b6b2efcd`); M2 (`9f2a4e72`); M3 (`59d4368b`); M4 measure-first complete — no build, re-measure gate set; M5 merged (`ffcc2108`; commits `35f684ff`, fix `f64ebfd2`). Remaining follow-up: the honesty-gate repeat log scan (see Validation) once post-merge usage accumulates; it also discharges the M4 re-measure gate.
Landed M1 evidence: independent review (claude) round 1 verdict changes-required (Date/toJSON degraded to {} — data-loss regression; getter-throw hole; test gaps), fixed in `3b495487`, re-review verdict approve. Known accepted divergences from JSON.stringify, recorded not fixed: boxed primitives unwrap, console.log guard still drops undefined-containing values, Object.assign-based downstream merge of returned output would hit the own-`__proto__` property (own-ness is test-pinned at the serializer boundary). Worker receipts: `~/.agents/runtime/session-query-index/receipts/srf-m1*.md`.

M2 implemented and merged 2026-09-06 (merge `9f2a4e72`, final `4d24d15f`) by a DeepSeek deepseek-v4-flash lane; one review round (claude) verdict approve with a minor fixed pre-merge (session error shapes now name the ambiguous-reference `candidates` field). Accepted deviations, review-endorsed: mutator shapes declare real resolved status strings rather than "returns void"; JSON-envelope tools (memory, shell-job, subagent controls) document their JSON-string behavior instead of converting to structured returns (M2 item 3 scoped structured returns to session-browser tools); the completeness guard derives the scriptable set from the gpt-4o and gpt-5.6 standard registries. Recorded reviewer notes for later: tool-policy.ts's second buildAgentTools lacks the scripted-path bypass (latent, no scripted tools in subagent sets); scripted session calls skip the tool byte check but stay bounded by maxChars + run-code serialize cap; the guard's registry fixture is hand-built (anchors mitigate).

M3 implemented and merged 2026-09-06 (merge `59d4368b`, final `479ba1dc`) by the same DeepSeek lane. The open question is settled with measurement: promoting full signatures for all non-essential tools would grow the rendered header ~3.9x (honest delta +8,080 chars over the exact rendered registry; the receipt's +10,482 used a registry 9 tools larger), so the header stays names-only and signature teaching happens at failure time via the shared tools-header renderer. Review verdict approve; recorded minors for later lanes: MAX_OBJECT_DEPTH lacks a pinning test, literal unions bypass the 80-char inline cap (latent), the untyped-schema fallback renders 'object' instead of 'unknown' (unreachable today).

Original status: proposed 2026-09-05; nothing else implemented. Written from two
independent log scans of real September 1–5 sessions (~170 and 260 `run_code`
calls, overlapping windows). Findings and evidence:
[docs/research/tool-real-world-log-audit-2026-09-05.md](../research/tool-real-world-log-audit-2026-09-05.md).

Read before touching `source/services/sandboxed-code-host/host-worker.ts`,
`source/tools/system/run-code/`, or any tool's `scriptedReturnShape`.

Three premises are already settled, so do not re-derive them:

- **The dominant failure is not execution.** Median nested execution was 42 ms.
  The cost is in authoring the script and consuming its result.
- **Output truncation is already half-fixed.** `clip` in
  `source/tools/system/run-code/run-code.ts` saves a retrieval artifact for the
  final output. Do not rebuild it; the gap is per-item batch results.
- **Approval denials and timeouts are not a priority.** Neither scan found a
  meaningful count in 400+ calls.

Milestones are independently shippable and ordered by observed cost. M1 and M2
cover the two largest failure classes and are narrow; do them first.

## M1 — `undefined` in a return value must not discard completed work

**Problem.** `json()` (`source/services/sandboxed-code-host/host-worker.ts:18`)
returns `false` for `undefined` anywhere in the value, where `JSON.stringify`
would simply drop the key. Any projection over an optional or void field fails
the whole script. The message ("Script return value must be JSON-safe") names
no field, so the agent cannot tell which one. Worst observed case: a script
created three files, returned `x.value.path`, failed — and the next shell call
found the files already written
(`~/.local/share/term2-nodejs/conversations/f2575c89-2316-47c8-93a7-d7259667e11b.jsonl:98`).

**Change.** Match `JSON.stringify` semantics: drop `undefined` object
properties, encode `undefined` array elements as `null`, and reject only
functions, symbols, `BigInt`, non-finite numbers, and cycles. Keep the two
distinct messages for safety versus size that
`sandboxed-code-host.ts:189` already separates.

When a value is genuinely unserializable, the error must carry the JSON path of
the first offender and state that nested effects already ran:

    Script return value is not JSON-safe: $.results[2].fn is a function.
    2 nested tool calls already completed — inspect state before retrying.

**Why this shape.** The old message invited blind replay of a script whose
side effects had already landed. Naming the path also removes most of the
guess-and-retry loop even when the strict rejection is correct.

**Tests.** `sandboxed-code-host.test.ts`: `undefined` fields survive; a function
value fails with its path; array holes become `null`. Regression case mirroring
the three-file create.

## M2 — Return contracts must be declarable and discoverable

**Problem.** Only `read_file`, `glob`, and `code_context_search` declare
`scriptedReturnShape`. `grep`, `apply_patch`, `create_file`, `search_replace`,
`session_read`, and `memory_retrieve` do not, so agents guess field names, get
`undefined`, and land in M1. `describeTool`
(`source/tools/system/run-code/run-code.ts:213`) returns name, description, and
parameters — it drops `scriptedReturnShape` even when the tool declares one,
though `tools-header.ts` can render it.

**Change.**

1. Add `scriptedReturnShape` to every tool reachable as `tools.*`. Mutators
   declare it explicitly rather than omitting it: `returns void`.
2. Include `scriptedReturnShape` in `describeTool`'s payload.
3. Session-browser tools (`source/tools/session-browser/session-browser-tools.ts:65`)
   return serialized JSON strings that scripts then treat as objects. Return
   structured values on the scripted path while preserving the direct-call
   output format.

**Tests.** A registry-completeness test asserting every scriptable tool
declares a shape — this is the part that stops the gap reopening. Plus
`describe` round-trip and a session-tool scripted-shape test.

## M3 — Schema errors should teach the correct call

**Problem.** 16 parameter-validation failures in one day: `skill_name` for
`name`, `jobId` for `job_id`/`target`, `search`/`replace` on `search_replace`.
One agent repeated its mistake in a later call; another looped 64 identical
`activate_skill` enum rejections. Only 8 of 260 scripts called `tools.describe`
first. The header lists non-essential tools by name alone, so the schema is
invisible until the call fails.

**Change.** At the `Invalid parameters` site
(`source/tools/system/run-code/run-code.ts:423`), append the tool's compact
signature — the same renderer `tools-header.ts` already uses — alongside the
issue list. Include short enums in the names-only listing, and expand nested
object shapes for the tools that carry them (`search_replace`).

**Open question.** Whether to promote the full signature for all non-essential
tools or only on first failure. Measure header token cost before deciding;
prefer the failure-time expansion if the difference is material.

## M4 — Partial results and per-item recovery

**Problem.** One bad nested argument rejects the whole `Promise.all`, and
successful sibling reads are re-run in the next script
(`~/.local/share/term2-nodejs/conversations/57c18684-1b1e-416d-8d46-73c5ce2f7d96.jsonl:250`).
A 19-file audit performed every read, failed on combined size, and redid the
work at 8 files.

**Change.** On script failure, return the per-call outcomes the harness already
records (it prints `[19 tool calls: read_file×19]`, so the data is in hand)
rather than only the count. Attach per-item truncation metadata so recovery
targets the clipped item instead of the batch.

**Verify before building.** The current description already recommends
`allSettled` and bounded output, and top-level clipping already saves an
artifact. Measure adoption in fresh sessions first: the logged failures ran on
older snapshots, and part of this milestone may already be solved.

**Outcome (2026-09-06, measure-first scan complete — no build).** Receipt
`~/.agents/runtime/session-query-index/receipts/srf-m4.md`: across a 2.4 h
window (46 `run_code` scripts, 3 sessions; only 5 strictly post-M1), the
target class — whole-batch rejection from one bad nested argument and sibling
re-runs — occurred 0 times; bounded-output handling is well adopted and clip
events dropped to 0 vs a 14.1% baseline. The one audit-class discard in-window
ran on a pre-M1 runtime snapshot. Re-measure once the post-M1 window reaches
~≥100 scripts across ≥5 sessions; build this milestone only if that repeat
measurement shows target-class events. The plan's proposed shape (per-call
outcomes at the summary site + per-item truncation metadata) remains the design
to build if triggered.

## M5 — Code-inside-code and telemetry

Two smaller items, batchable:

- **Syntax errors** (8 in one day: unescaped backticks in embedded patches and
  JSX, a TypeScript annotation, one dynamic import) return a bare
  `Unexpected identifier 'm2b'`. Return the location with a short offending
  excerpt and JavaScript-only guidance. Keep a direct, non-scripted path for
  literal patch and file content so payloads never traverse a JS string layer —
  one such failure cascaded into the 100 k streamed-argument guard and needed a
  user `continue`.
- **Telemetry conflates completion with success.** Every persisted `run_code`
  command message reads `completed`, including failures, and the
  failure-prefix check at `run-code.ts:244` misses `Result: Error:`. Persist the
  script `ok` boolean beside the lifecycle status, and keep script success,
  nested-tool success, and task success separate wherever they are reported.

  **Landed (2026-09-06, `ffcc2108`).** Syntax errors carry location + excerpt +
  JS-only guidance from the worker template (`syntaxErrorDetail`), with a
  graceful end-of-script fallback message for unterminated constructs and a
  dynamic-import unavailability note (import still disabled). The persisted
  success bit now uses `isUnsuccessfulRunCodeOutput`: failure prefixes plus
  `Result:`-headed values evaluated by the shared `isSuccessOutput` heuristic
  (covers `Error:` text and structured `{error: ...}` envelopes); lifecycle
  `status` stays `completed` and the distinct levels stay distinct. Review
  verdict approve; fix commit `f64ebfd2` closed the reviewer's structured-envelope
  finding pre-merge. Receipt: `~/.agents/runtime/session-query-index/receipts/srf-m5.md`.

## Validation

Per the repo's test policy, each milestone lands with focused tests plus the
run_code and sandboxed-code-host suites; the isolated full suite is the handoff
gate. Beyond tests, the honest measure of M1–M3 is a repeat log scan over a
comparable window after they ship: the same four failure categories should
shrink. Do not claim improvement from the diff alone.

### Post-merge re-scan (2026-09-07, bounded — does not discharge the M4 gate)

Scanned the 2026-09-06/07 application logs and persisted conversations: 849
finished executions, 66 `ok:false` (7.8%). Confirmed live that the
Invalid-parameters class (the largest raw bucket) now carries the
`Signature:` teaching from M3. Three classes remained unaddressed by M1–M5
and were fixed in the `run-code-dx` branch:

1. **Runtime errors carried no location.** M5 scoped locations to compile-time
   SyntaxErrors; uncaught runtime errors (`m3b2 is not defined`) reached the
   model with no line. The worker now appends `At script Line N:COL: excerpt`
   using the same `workflow.js` frame extraction, tolerating the `at `
   prefix that runtime (but not compile) stacks carry.
2. **Nested tool errors did not name the tool.** The script envelope threw
   `Error(String(response.error))`, so a fan-out failure read as
   `Search failed: rg: …` with no call site. The envelope now throws
   `tools.<member> failed: …`.
3. **Prohibited tool access surfaced as a bare TypeError.** An unexposed name
   read as `undefined`, so a call failed with `tools.shell is not a
   function` (ten occurrences in the window). The namespace is now a
   realm-local Proxy whose unknown members throw
   `Unknown tool "x". Available: …`, the same wording as the prepared-call
   path. This deliberately replaces the "unknown names are simply absent"
   contract; registry enumeration (`Object.keys(tools)`) is unchanged.

The M4 re-measure gate still needs ~≥100 strictly post-M1 scripts across ≥5
sessions; this scan does not satisfy it.
