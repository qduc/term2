# Bare token-efficiency evidence (2026-10-24)

## Outcome: original aggregate-efficiency objective blocked

Independent final verdict: **ACCEPT source/security behavior in scope and sampled
artifact quality; ACCEPT limited descriptive schema/accounting evidence; REJECT
an overall completion claim for lower end-to-end tokens.** Three candidate wire
attempts lack authoritative model usage. Implementation acceptance is not mission
completion.

## Change and decision

The bounded implementation keeps bare's existing authority and direct tools. It
advertises only foreground shell options (command, description, deadline, output
limit, sandbox), shortens their descriptions, and adds task-neutral guidance to
batch known steps and reduce output locally **without omitting instructions,
checks, exit codes, or failure evidence**. Background-task controls were not useful
in bare because that capability is absent. Other profiles retain their surface.
`run_code` is not enabled: it is a candidate mechanism, not a requirement, and its
previous generic surface added 692 tools-field tokens per model request.

`presentBareShell` in `source/tools/system/bare-shell.ts` changes presentation,
not execution. `buildAgentTools` in `source/lib/agent-factory.ts` now consistently
uses `canonicalParameters` for normalization, validation and approval preparation.
This matters when an advertised subset differs from the executable schema.
No approval resolver, parallel-safety flag, workspace authority, timeout or
output/call budget was relaxed.

The tested source commit is `60f105ed6e5cc5027053f60abbf18f51e3257a17`.
The later merge from main only imports test-history documentation; source blobs
are unchanged. Baseline runtime: `5b5395aa`; integration fixture base: `12dabc92`.

## Observations, not an unconditional performance promise

Provider tools-field attribution is **1,632 tokens/request baseline versus 1,106
candidate**: 526 fewer (32.2%). The added prompt guidance has a cost too; the live
measurements count it. All input tokens, including cache hits on every request,
output, schema overhead, retries and reported failed work are included.

Two order-balanced repetitions covered exact aggregation over 12 log shards,
source-backed repository investigation, a small event-summary edit (136 hidden
cases), and a two-module pagination edit (14 grouped hidden checks). Each arm
passed 7/8 initial task gates. Baseline once confused a background status tool's
parallel-safety flag with foreground shell; candidate once streamed 62,370 action
argument characters without executing a tool before its 300-second deadline.
Both failed cases passed one fresh, original-prompt rework with no answer hints.
Every final required artifact passed its original checker; no test was dropped.

The table includes **all nine attempts per arm**, including those original failures
and their reworks. Candidate usage is incomplete, not zero, for its interrupted
request and two unmetered retry captures. Therefore its token and cost figures are
**lower bounds**, not a precise all-attempt saving:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Reported total tokens | 797,015 | at least 643,603 |
| Reported input | 783,845 | at least 633,001 |
| Reported output | 13,170 | at least 10,602 |
| Reported cached input | 619,008 | 513,408 |
| Catalog cost proxy | $0.523278 | at least $0.396548 |
| All-attempt elapsed seconds | 336.31 | 666.39 |
| Initial task passes | 7/8 | 7/8 |
| Accepted task artifacts after bounded rework | 8/8 | 8/8 |

These data support the smaller interface and show useful local aggregation, but
**do not establish an exact overall percentage cost/token reduction**. No latency
win is claimed. Per-workload reported totals including failed attempts/reworks:
audit 120,183 vs at least 77,457; small edit 148,263 vs 154,602; multi-file edit
182,153 vs 149,634; investigation 346,416 vs 261,910. Rework and model variability
contribute to those totals; they are not isolated causal effects of the schema.
The small edit regresses slightly rather than being hidden as an unfavorable case.

All reported first requests were cold (zero cached tokens); continuations warmed
naturally. True warm-start comparisons remain untested. Cache hits and priced
costs vary; catalog prices are not invoices. One model/effort, two repetitions,
and this workload mix cannot prove a global optimum or population quality parity.

## Accounting and retention

The companion [JSON](bare-token-efficiency-20261024.json) retains the full attempt
matrix, environment, source commits, exact missing-usage request locators and
stdout hashes. Raw prompts, commands, frozen checkers, artifacts, runtimes,
NDJSON and per-request wire locators remain under
`.worktrees/bare-efficiency-final-evidence-20261024/` in the primary checkout.
That machine-local corpus must be retained before worktree/runtime cleanup.

The rejected prototype's 16 attempts remain separately under
`.worktrees/bare-efficiency-evidence-20261024/`. Its measurements are not silently
pooled with the repaired candidate. The campaign used 34 task attempts, below
4 million reported tokens and $4 reported catalog proxy, plus unknown usage on
interrupted responses; no further paid experiment was launched.

Accounting joins provider session IDs across UTC day directories, and sums all
per-request cost updates. A WebSocket recovery can reset the CLI's final-segment
aggregate; using that final alone missed 5,313 input/18 output tokens in one
completed candidate attempt. Raw-update totals and wire usage now reconcile for
all metered requests. Unknown usage is explicitly unresolved rather than guessed.

## Runtime-validation retro

The independent verifier rejected the prototype before publication: replacing the
advertised schema also replaced some normalization/validation consumers. A hidden
`background: "false"` became truthy; invalid hidden values could reach execution;
null monitor fields no longer normalized like standard shell.

Preventable: yes. The two schema roles were representable but not consistently
consumed. Origin: latent assembly assumption exposed by this new projection, not
an escaped shipped feature. The canonical schema remains the single executable
source of truth; all three root-assembly consumers now use it. Existing
`run_code` admission already uses canonical schemas. The generic run-loop first
prepares model arguments using presentation, but canonical approval/execute
wrappers reject invalid values before effects. The subagent registry uses its
own original executable definitions (no `presentBareShell` projection); inspected
nested role calls are not this presentation path. No sibling was silently changed.

The structural artifact is category-covering **integration** coverage in
`source/tools/system/run-code/shell.integration.test.ts`: actual processes/files,
coercible and invalid omitted fields, nonzero exit evidence and approval denial.
The same independent differential probe fails before repair and matches standard
behavior afterward. No permanent unit tests or new static guards were added.

## Verification and stopping

Exhaustive former run records are archived at `42724797:docs/test-results.json`.
The useful failure signature and comparison remain below. On the tested source: full integration 226 pass/1 skip;
provider black-box 221 pass/1 skip; e2e 32 pass/4 skip; static guards 28 pass;
typecheck and lint pass. The first full integration run had one 10-second generic
model-listing timeout (225 pass/1 fail/1 skip); its focused test and unchanged full
rerun pass. This is retained as an observation, not an erased failure or permanent
allowlist. The approval fixture lane was not modified.

Independent review first rejected canonical normalization, then accepted the
repair after real shell processes and built-CLI probes. Built-CLI evidence covers
actual shell batching/filtering, omitted/null/invalid args, approved nonzero exit,
explicit unsandboxed denial with no file effect, and byte-identical standard-profile
tool definitions. The final independent reviewer explicitly leaves aggregate
efficiency **UNVERIFIED**; no exact saving or mission-completion claim is made.

Stop here rather than adding more mechanisms or sampling until a favorable
percentage appears. Further opportunities are a separately controlled warm-start
study, a compact bare-specific code-mode experiment, and investigation of model
runaway output/recovery accounting. They are not claimed solved by this change.

## Retained audit archive and exact remaining blocker

All audit-required final, rejected-prototype and preliminary code-mode captures
are copied outside the implementation worktree to
`/home/qduc/term2/.term2/evidence/bare-efficiency-20261024/`: **397 wire captures,
1,095 hashed data files**. `manifest.json` records original and archive SHA-256,
byte sizes and credential/identity redaction paths; `manifest.sha256` protects the
manifest. Sanitized copies, not external locators alone, are retained. The
companion JSON records the manifest hash and archived paths for the three
outstanding requests. Original source locators remain provenance only.

One bounded read-only recovery pass searched the existing raw response captures
and exact-request/known-response application records, with a 60-second/256-MB
ceiling and **no network or paid call**. Its sole numeric candidate was
`response.tool_usage.image_gen` zeros—not whole-response language-model usage.
It was explicitly rejected as billing evidence. No authoritative model usage or
bound was recovered. Argument character counts and request byte fingerprints
were not converted into billed tokens.

Concrete next options are authoritative provider/session usage (or an
operator-supported authoritative bound) for the three archived requests; or a
separately authorized, predeclared fully metered cohort after fixing interruption
accounting. Neither has been performed. The controller can separately decide
whether accepted source should be integrated as an interface improvement, but
must not label that decision completion of the original efficiency objective.
