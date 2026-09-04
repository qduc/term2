# Improvement plan: `run_code` primary path

**Status: experiments in progress (opened 2026-09-04).** Derived from the
field test in [code-mode-field-test.md](code-mode-field-test.md) — read its
Round 1, 1.5, and 2 results first; this document only proposes repairs for
what those rounds actually observed.

## Standing rule for this plan

**No change is committed until a real model run shows the specific failure it
targets is gone.** Unit tests are necessary and not sufficient: every finding
here is about what a model *chooses* to do, and no unit test observes a
choice. Each experiment below names its trigger task, its before-measurement,
and the after-measurement that would count as a fix.

## The two findings worth acting on

Six runs across three models (rounds 1 and 2) plus one real interactive task
(round 1.5) produced two problems that repeat. Everything else in the field
test either came back clean or lacks the evidence to act on.

### A. The size-limit error gives the model nothing to act on

`source/services/sandboxed-code-host/sandboxed-code-host.ts:112` fails a
script with:

```
${subject} output must be JSON-safe and within the configured size limit
```

Two distinct failures share one message — output that is not JSON-safe, and
output that is merely too large — and it reports neither the actual size, the
limit, nor which field blew the budget. In round 1.5 a 19-file fan-out hit
this and the model abandoned scripting entirely for 19 serial direct reads.

The cap it hit is `RUN_CODE_LIMITS.maxOutputBytes = 262_144`
(`source/tools/system/run-code/run-code.ts:49`); the workflow default is
`65_536`. Neither number reaches the model.

**Why this matters more than a tuning issue:** the fan-out is the exact shape
`run_code` exists to make cheap. A cap that rejects it without a gradient to
retry against converts the design's headline benefit into its baseline.

### B. Models barely use `run_code` at all

| round | model | requests | `run_code` | what it used instead |
| --- | --- | --- | --- | --- |
| 2 / task A | deepseek-v4-flash | 18 | 1 | read_file 13, grep 8, shell 3 |
| 2 / task A | muse-spark-1.3 | 57 | 2 | shell 34, read_file 26 |
| 2 / task A | glm-5.3-flash | 25 | 0 | shell 31, grep 3 |
| 2 / task B | all three | 9–17 | **0** | shell, read_file, search_replace |
| 1.5 | gpt-5.6-luna | — | 10 | shell 38, direct reads 30 |

Making `run_code` the primary path did not make it the primary path. The
`not directly callable` error fires 1–8 times per run, so models *do* hit the
restriction — and then reach for `shell` rather than retrying through
`run_code`. That message
(`source/tools/system/run-code/run-code.ts:366`) says "use an auto-approved
alternative", which is advice to route *around* `run_code`, not through it.

## Experiments

Each experiment is: reproduce the failure on an unmodified build, apply one
change, rerun the identical task, compare. Runs use
`.coord/field-test/r2/run.sh` and are read back with
`.coord/field-test/r2/analyze.sh <dir-prefix>`, which groups by `sessionId`.

### E1 — RESOLVED, but not by the change it proposed (`9c406684`, branch `e1-fix`)

The baseline runs falsified this experiment's premise. The fan-out did not
fail only because the *return* was too large; every in-script `read_file` was
silently capped at `DEFAULT_TOOL_RESULT_MAX_BYTES` (40,000) — the cap that
exists to protect **model context** — while its header still advertised the
full line count. A script that counted lines therefore got a confidently
wrong answer with no error: 58,885 bytes arrived as 39,976 with a header
reading `(1393 lines) [lines 1-1393]`, and muse computed 878 lines for a
1,393-line file, catching it only by cross-checking `wc -l`.

A scripted result never enters model context — the script reduces it, and only
the script's return value reaches the model, capped separately. The cap was
applied one layer too deep.

**The fix** adds a `scripted` marker to `ToolInvocationContext`, set by
`run_code` on nested dispatch and read by `read_file` to use a 100,000-byte
cap. The seam is *who receives the result*, not which tool. The original
error-message split shipped alongside it, since it was already written and
tested, but it was not the cause.

**Verified by real model run**, using a discriminator the model cannot fake
from the header — the tail of the string the script receives:

- before: `...tool-output/output-475861-...txt` (the truncation note)
- after: `1391:   };  1392: }  1393:` (the file's actual last line)

Gate: 475 files / 6432 tests green on `pnpm test:lane`; the one error is a
pre-existing non-isolated flake in `logging-service.test.ts`, which passes
alone.

**Two process notes.** I first patched `maxResultBytes` as if it were a tool
parameter; it is a factory dependency, so the change did nothing — and a unit
test would have passed while the real run caught it. And model self-reports
were unreliable throughout: the same prompt returned "1393" (the model reading
the header rather than counting) and "801" from the same build. Ask for
something that cannot be derived from metadata.

### E1 (original, superseded) — split the size error and name the numbers

**Change.** Separate the two failure modes. For over-size, report the actual
byte count, the limit, and a chunking suggestion. For non-JSON-safe, name the
offending path.

**Trigger task.** A fan-out that reliably exceeds 262,144 bytes of returned
output — read every file under a directory and return the contents.

**Before.** Script fails; model falls back to serial direct reads.
**Counts as fixed.** The model retries *within* `run_code` — chunking, or
returning summaries instead of contents — rather than abandoning the script.
A run that still falls back to serial reads is a failed experiment even if
the new message is strictly more accurate.

### E2 — RESOLVED, and it was not the refusal message (branch `e2-glob`)

Two candidates were investigated and one was killed outright.

**Killed: `create_file` corrupts large payloads.** A baseline run reported that
payloads over ~34KB come back with newlines replaced by commas. Not
reproducible: `create_file` writes 60KB of multi-line content byte-for-byte.
The comma signature is what `Array.prototype.toString()` produces, and passing
an array where a string is required is rejected before execute —
`normalizeToolParameters` leaves the array intact and `safeParse` fails, so
`run_code` returns a validation error. The corruption is reachable only by
calling `execute` directly, which the application never does. **No defect.**

**Confirmed: `glob` silently truncates a scripted match set.** Same defect
class as E1. Inside a script, `glob` returns 50 of 86 matches and announces the
cap as prose appended to the payload:

```
source/tools/file/glob.ts

Note: Results limited to 50 files. Found 86 total matches. Use max_results parameter to see more.
```

A script splitting on newlines reads that sentence as another path. This is
what made muse examine 33 files and miss `source/tools/system/shell.ts` — the
longest file, and the literal answer to the task it was given.

**The fix** raises the default to 5,000 results for scripted calls, reusing
E1's `scripted` context marker. An explicit `max_results` still wins.
Merged as `c8feb28b` / `cdc9719f`; 475 files / 6435 tests green on
`pnpm test:lane`.

**Verification: the defect is fixed; the stated pass bar was not met.** Both
halves matter and they point in different directions.

The truncation is gone, on all three models. deepseek now enumerates 82
matches where it previously saw 50; muse reports the full 51 non-test files
where it previously worked from 33; glm sees all 92 matches. muse's failure
messages now also carry real byte counts (`519288`), from E1's error-message
change.

But the bar was "muse finds `shell.ts`", and it does not. Having correctly
enumerated all 51 files, muse then narrowed to the 7 depth-1 files to fit the
return under the 262,144-byte cap and answered `format-helpers.ts` (288
lines). glm, given the whole file, still reports `shell.ts` as 801 lines — a
model-side counting error, not truncation: the same model on the same build
returns `1393:` when asked for the raw tail of the string it received.

So the harness now delivers complete inputs, and two of three models still
answer wrongly — by choosing to shrink the question rather than summarise, and
by miscounting. **That is a real limit on what fixing truncation can buy**, and
it is the honest result: E1 and E2 remove a class of harness-caused wrong
answers without making these models reliable at this task.

### E2 (original, superseded) — make the approval refusal point back at `run_code`

**Change.** Rewrite the `not directly callable` guidance so it states the
call is available *inside a script* and shows the shape, instead of
recommending an "auto-approved alternative".

**Trigger task.** Task A from round 2, which produced 1–8 of these per run.
**Before.** Model switches to `shell`.
**Counts as fixed.** A measurable drop in post-refusal `shell` calls, with
those calls moving into `run_code`, on at least 2 of 3 models.

### E3 — deferred pending E1/E2

Whether the prompt itself under-sells `run_code` is the obvious third
hypothesis for finding B, but E2 tests a cheaper and more specific cause
first. Do not touch `source/prompts/` until E2 has run: prompt edits are
product behaviour, they invalidate provider prompt-cache assumptions, and
they would confound the E2 measurement.

## Not acting on these

- **Concerns 1, 2, 3, 4, 9, 11** — came back clean in round 1.
- **Concern 7 (silently wrong results)** — never triggered; no evidence.
- **muse's false completion claim** (round 2, task A: reported committing,
  committed nothing) — real, but a self-report reliability issue, not a
  code-mode one. Belongs in its own investigation.

## E4 — structured results for scripted calls (branch `e4-shape`)

**Change.** `glob`, `read_file`, and `code_context_search` return fields to a
script instead of prose: `{ paths, total, truncated }`,
`{ path, totalLines, content, truncated, fullOutputPath? }`,
`{ queryType, matches|results, truncated, partial }`. Direct calls are
unchanged. A `scriptedReturnShape` on the tool definition is rendered in the
script tools header, because a shape nobody advertises still costs discovery.

**Why.** Every parsing failure in rounds 1–2 was a shape problem, and both
truncation bugs (E1, E2) were caps announced in prose to a consumer that reads
fields. `truncated: true` cannot be missed the way a sentence can.

### The first attempt shipped broken, and the real-run caught it

Unit tests passed; the real run did not. Models reported the tools were
"returning empty/odd shapes", then diagnosed it exactly:

> inside scripts, `read_file`/`glob` return the literal string
> `"[object Object]"` (a broken bridge), while `grep` works

Cause: `trimToolOutput` (`source/utils/output/trim-tool-output.ts`) coerces any
non-string, non-content-part result with `String(output ?? '')`, and
`agent-factory.ts` applies it to every wrapped tool. Its own comment records
the intent — arbitrary objects keep "the old String() coercion" so a tool
cannot escape the size limit.

**This is the same defect class as E1, E2 and E3 for the fourth time:** a
model-context protection applied to a value the model never sees. The fix is
the same seam — `agent-factory.ts` skips the trim entirely for a scripted call.

**Method note.** My unit tests called `tool.execute` directly and so never
crossed the agent-factory wrapper where the coercion lives. The regression test
added with the fix exercises the wrapped path. A unit test that bypasses the
layer a bug lives in will pass for the wrong reason — the same mistake as E1's
`maxResultBytes` patch, which was inert and also passed its unit test.

## E5 — does code-mode improve quality, speed, or cost? (in flight)

The release question, and the gap all three outside reviewers named: three
rounds of field testing produced **no cost or latency data**, despite
"cost/latency gets worse on ordinary turns" being a declared revert trigger.

Paired design: the same tasks and models run against
`.worktrees/e5-nocodemode` (detached at `ab5938cb` = `2ab57206^1`, the
pre-change main that already contains the sandboxed host, so the comparison
isolates the surface reduction) and against the codemode build. Harness in
`.coord/field-test/e5/`; `report.sh` pairs cells by recorded traffic session id.

### Settled before any task ran

Identical trivial prompt, both builds:

| build | tools exposed | prompt tokens |
| --- | --- | --- |
| no-codemode | 27 | 18,602 |
| codemode | 9 | 15,670 |

**−2,932 tokens (−15.8%) on every request**, paid back on all traffic whether
or not a script is ever written. It also corrects the record: the surface
reduction is 27 → 9, not the 14 → 9 the plan claims.

### First cells: the saving is not unconditional

Task D (needs `web_search`, script-only under codemode):

| model | arm | requests | input tokens | wall |
| --- | --- | --- | --- | --- |
| deepseek | no-codemode | 3 | 71,626 | 15s |
| deepseek | codemode | 3 | 56,751 | 11s |
| glm | no-codemode | 2 | 43,194 | 35s |
| glm | codemode | 3 | **51,205** | 11s |

Quality was parity — both arms answered correctly with sources on all three
models. But codemode cost glm **an extra round trip**: `web_search` is direct
in the baseline and must be reached through `run_code` here. The per-request
saving is unconditional; whether it nets out depends on whether the reduced
surface adds a round trip for that task.

Tasks B and C are the cleaner test of pure overhead: both arms expose the same
file tools, so the only difference is payload size with no round-trip
confound.

**Caveat on cost-after-cache:** prompt caching is prefix-dependent and the two
builds have different prefixes, so cached-token counts are not comparable
across arms in a single run. Raw input tokens are the primary metric here.
