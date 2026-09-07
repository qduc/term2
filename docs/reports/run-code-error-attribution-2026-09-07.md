# `run_code` failed-finish attribution (2026-09-07)

## Scope and accounting

This is a read-only attribution of the application-log window requested by the
coordinator:

- **Window:** `2026-09-06 07:43:49` through `2026-09-07 07:43:49`, local wall
  time (UTC+7).
- **Inputs:** `term2-2026-09-06.log`, rotations `.1` through `.15`, and
  `term2-2026-09-07.log` under
  `~/.local/state/term2-nodejs/logs/`. Live logging was not stopped or
  modified.
- **Counted record:** one JSONL record with
  `message == "run_code execution finished"` and `ok == false`. These are
  records, not unique incidents. Several records share a correlation ID, and
  five records have no correlation ID.

The requested failed-finish count is reproduced exactly:

| Predicate | Records |
| --- | ---: |
| All `run_code execution finished` records in the window | 813 |
| `ok == true` | 747 |
| `ok == false` | **66** |

The plan's post-merge note reports 849 finished executions for this scan. The
current bounded projection gives 813 (the same 66 failures); the 36-record
denominator difference is unresolved and should not be used to infer a rate.
The requested failed-record accounting is unaffected.

## Attribution summary

The table is a disjoint primary classification and sums to 66. Prefixes are
the short, already-truncated result text retained in provider request logs;
they are not expanded from prompt or transcript text. A **probe** label would
require positive evidence of deliberate fault injection (for example, an
explicit test marker or an intentional injected fault). No such evidence was
retained for these records, so the table does not label any record a probe.
Agent authoring friction is harness data and remains in scope; coding, audit,
and model-menu activity is normal live harness workload, not evidence of a
controlled probe by itself.

| Primary class | Count | Disposition | Sanitized evidence identities (timestamp / correlation prefix) |
| --- | ---: | --- | --- |
| Invalid tool parameters | 20 | **Historical authoring-diagnostic class; mitigation shipped, outcome unestablished.** These prefixes are consistent with the M3 schema/signature failures, and the current `run_code` path teaches `Signature:` at the failure site. The count does not show that the class was eliminated or that the mitigation is adequate. | `2026-09-06 08:30:44/7179deda`, `08:33:44/7179deda`, `08:50:10/d2270daf`, `09:00:47/5e6ff99f`, `12:52:20/8f6bc390`, `13:20:45/91a7f39a`, `15:24:55/5f097129`, `15:46:16/cfbd6dbf`, `15:54:22/a6cd70bf`, `17:24:45/3863547d`, `21:52:06/8518bf5a`, `22:25:11/501efbc1`, `22:36:26/b438bd76`, `23:04:21/b490126a`, `23:40:54/15f69ed5` (15 IDs, 20 records) |
| Compile/syntax errors (`Unexpected...`) | 8 | **Historical authoring-diagnostic class; mitigation shipped, outcome unestablished.** This prefix class is consistent with M5 syntax-location/JavaScript guidance. It is not evidence of a timeout, nor evidence that syntax failures stopped after the merge. | `12:44:40/5df667e6`, `15:15:39/157d1d21`, `15:38:26/157d1d21`, `17:27:00/3863547d`, `22:49:02/none`, `22:51:11/none`, `22:51:55/none`, `23:27:25/none` |
| Dynamic import unavailable | 1 | **Historical authoring-diagnostic class; mitigation shipped, outcome unestablished.** The prefix is consistent with the sandbox's dynamic-import restriction and its explanatory diagnostic; this report does not establish recurrence or effect. | `17:12:57/3863547d` |
| Runtime `Cannot...` error | 3 | **Historical authoring-diagnostic class; mitigation shipped near the end of the window, outcome unestablished.** The diagnostics follow-up added the `At script Line N:COL` location for uncaught runtime errors, but these records alone cannot show post-merge behavior. | `12:52:02/8f6bc390`, `12:53:57/99927be1`, `13:21:17/91a7f39a` |
| Nested error beginning `Search...` | 3 | **Historical authoring-diagnostic class; mitigation shipped near the end of the window, outcome unestablished.** The prefix is consistent with the previously ambiguous nested-tool envelope; the follow-up now names `tools.<member>`, but these records do not establish recurrence or adequacy. | `23:04:11/a968d6ae`, `2026-09-07 00:26:11/9e931ccd`, `00:26:15/9e931ccd` |
| Nested error beginning `tools...` | 2 | **Historical authoring-diagnostic class; mitigation shipped near the end of the window, outcome unestablished.** The prefix is consistent with the tool-name attribution follow-up; no positive fault-injection evidence makes either record a probe. | `13:56:37/1868582f`, `17:13:08/3863547d` |
| High call-count run | 1 | **Unclassified.** The finish record reports 197 nested calls, but no actual limit/aggregation error body was recovered. A high count alone does not prove budget exhaustion or identify the failure, and does not justify raising the cap or replaying effects. | `15:25:24/ddb1cc60` (`toolCalls: 197`, Codex `gpt-6-astra`) |
| No returned result body available in bounded projection | 25 | **Projection/evidence gap, not proof of a lost result.** The bounded application/provider-request projection has `ok:false` and a call count but no joinable returned error body. Canonical session/provider traffic was not inspected here, so this cannot distinguish an absent result from a logging/join/projection limitation. 24 are Codex records and one is a DeepSeek record with a missing correlation ID. | Direct-call examples: `12:11:32/db663c81`, `16:02:12/4914743e`, `16:46:30/a875fd0c`, `2026-09-07 00:03:47/91d25a1b`; nested-call examples: `12:21:13/d4dbb316`, `15:48:24/9839fc88`, `17:14:03/dcce8d25`, `2026-09-07 00:11:55/91d25a1b`; the no-ID record is `23:22:26/none` |
| Live authoring failure / unknown cause with `require...` | 1 | **Unknown cause; not a probe.** There is no positive deliberate-fault-injection evidence. The prefix is compatible with the sandbox restriction on Node `require`, but the retained projection cannot establish that explanation. | `2026-09-07 00:05:23/9e931ccd` |
| Live authoring failures / unknown cause (`susp...`, lowercase `unexp...`) | 2 | **Unknown cause; not probes.** Both occurred in a model-nicknames coding session, which establishes live harness workload but not deliberate fault injection. The retained log keeps only a 53-character truncated result prefix, so the causes remain unresolved. | `15:25:38/157d1d21` (`unexp...`), `15:25:59/157d1d21` (`susp...`) |
| **Total** | **66** |  |  |

The workload context is about live harness use: surrounding first-message
previews identify run-code/session-tool audits, guard review, CI and test
repair, UI/model-menu work, continuation briefings, and independent review.
Those are normal coding/audit/model-menu harness activities, not controlled
fault-injection probes by themselves. Agent authoring friction counts as
harness data. This window does not establish how many of the 66 records were
ordinary end-user task failures; no end-user-versus-harness rate is inferred.

## What is established versus what remains unresolved

The 37 records in the six authoring-diagnostic rows are historical prefix
classes consistent with shipped diagnostic mitigations, not proof that the
failures were eliminated or that the post-fix behavior is adequate. Repository
history gives the relevant merge timing: M1 `b6b2efcd` at
`2026-09-05 23:08:25`, M2 `9f2a4e72` at `2026-09-06 01:10:59`, M3
`59d4368b` at `01:28:37`, M5 `ffcc2108` at `02:01:02`, and the runtime/tool
diagnostics follow-up `f04932fc` at `2026-09-07 00:35:09` (all local UTC+7).
Thus this window contains observations after the first four merges and around
the follow-up merge; it is not a controlled pre/post comparison. Recurrence,
effect, and mitigation adequacy remain unestablished. The current seams are
useful context only: shared `syntaxErrorDetail` and `runtimeErrorDetail`
worker diagnostics, `isUnsuccessfulRunCodeOutput`, the failure-time compact
signature, the `tools.<member> failed:` nested envelope, and the realm-local
unknown-tool message.

The exact unresolved accounting is **29 records**: 25 projection/evidence-gap
records, one unclassified high-call-count record, and three live authoring
failures of unknown cause. The 37 historical class records are not counted as
resolved outcomes; they are separately identified because their prefixes map
to diagnostic classes whose mitigations have shipped.

Two evidence-backed follow-up candidates remain for coordinator triage:

1. **Structured failed-finish observability (25 records).** The bounded
   application/provider-request projection contributes `ok` and `toolCalls`,
   but does not expose a returned tool body that can be joined to these
   finishes. Canonical session/provider traffic was not inspected, so this is
   an evidence/projection gap rather than a finding that results were lost.
   Five records also lack a correlation ID (four syntax-prefix records and one
   no-body record). A future change could emit a bounded error class/path and
   stable run/tool identity without logging script source or full tool output.
   This report does not choose a design or priority.
2. **One unclassified high-call-count failure.** `toolCalls:197` is not
   evidence of budget exhaustion. Investigate bounded partial-result/recovery
   diagnostics only if canonical evidence identifies a limit or aggregation
   error; do not increase the cap or replay completed effects based on this
   count alone.
3. **Three live authoring failures of unknown cause.** The `require...`,
   `susp...`, and lowercase `unexp...` prefixes lack positive deliberate
   fault-injection evidence. Keep them as live harness authoring data with
   unresolved cause rather than calling them probes.

There is no confirmed timeout class in these 66 records. One failed live
authoring record had a 10-second configured timeout, but its returned error
body is not available, so it is not safe to call that a timeout. No default
timeout, retry, approval, or output-cap change is justified by this
attribution.

## Reproducible bounded projections

The following queries were run against the complete input glob. They parse
JSONL, filter the local timestamp lexically (the fixed-width format sorts in
wall-time order), and project only counts or bounded metadata:

```bash
jq -s '
  [.[] | select(.message == "run_code execution finished"
    and .timestamp >= "2026-09-06 07:43:49"
    and .timestamp <= "2026-09-07 07:43:49")] |
  {total:length,
   ok:(map(select(.ok == true))|length),
   failed:(map(select(.ok == false))|length)}
' ~/.local/state/term2-nodejs/logs/term2-2026-09-06.log* \
  ~/.local/state/term2-nodejs/logs/term2-2026-09-07.log
```

```bash
jq -r '
  select(.message == "run_code execution finished" and .ok == false
    and .timestamp >= "2026-09-06 07:43:49"
    and .timestamp <= "2026-09-07 07:43:49") |
  [.timestamp, (.correlationId // "none"), .toolCalls] | @tsv
' ~/.local/state/term2-nodejs/logs/term2-2026-09-06.log* \
  ~/.local/state/term2-nodejs/logs/term2-2026-09-07.log
```

For attribution, each failed finish was joined only by its correlation ID to
the nearest preceding provider response containing a `run_code` function call
within the bounded application/provider-request projection;
for non-Codex providers, its call ID was then matched to the bounded `role:
tool` message in the subsequent provider request. The projection retained
only the result prefix (for example `Script failed: Inval...`,
`Script failed: Unexp...`, or `Unknown tool: ...`), its length, provider/model,
timestamp, and `toolCalls` count. Full scripts, prompts, tool arguments, and
tool output were not included in the report. The bounded records contain no
equivalent joinable returned body for the 25 records, which is why they remain
a projection/evidence gap rather than an invented root-error distribution.
Canonical session/provider traffic was not inspected, so this report does not
claim that those result bodies were absent there or lost in execution.

