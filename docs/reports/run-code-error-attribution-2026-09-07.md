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
they are not expanded from prompt or transcript text.

| Primary class | Count | Disposition | Sanitized evidence identities (timestamp / correlation prefix) |
| --- | ---: | --- | --- |
| Invalid tool parameters | 20 | **Already-fixed authoring diagnostics.** These are the M3 schema/signature failures; the current `run_code` path teaches `Signature:` at the failure site. | `2026-09-06 08:30:44/7179deda`, `08:33:44/7179deda`, `08:50:10/d2270daf`, `09:00:47/5e6ff99f`, `12:52:20/8f6bc390`, `13:20:45/91a7f39a`, `15:24:55/5f097129`, `15:46:16/cfbd6dbf`, `15:54:22/a6cd70bf`, `17:24:45/3863547d`, `21:52:06/8518bf5a`, `22:25:11/501efbc1`, `22:36:26/b438bd76`, `23:04:21/b490126a`, `23:40:54/15f69ed5` (15 IDs, 20 records) |
| Compile/syntax errors (`Unexpected...`) | 8 | **Already-fixed authoring diagnostics.** This is the M5 syntax-location/JavaScript-guidance class, not a timeout. | `12:44:40/5df667e6`, `15:15:39/157d1d21`, `15:38:26/157d1d21`, `17:27:00/3863547d`, `22:49:02/none`, `22:51:11/none`, `22:51:55/none`, `23:27:25/none` |
| Dynamic import unavailable | 1 | **Already-fixed authoring diagnostics.** The sandbox deliberately disallows dynamic import and now explains that constraint. | `17:12:57/3863547d` |
| Runtime `Cannot...` error | 3 | **Already-fixed authoring diagnostics.** The diagnostics follow-up added the `At script Line N:COL` location for uncaught runtime errors. | `12:52:02/8f6bc390`, `12:53:57/99927be1`, `13:21:17/91a7f39a` |
| Nested error beginning `Search...` | 3 | **Already-fixed authoring diagnostics.** The nested error now names the failing `tools.<member>` call rather than making the fan-out failure ambiguous. | `23:04:11/a968d6ae`, `2026-09-07 00:26:11/9e931ccd`, `00:26:15/9e931ccd` |
| Nested error beginning `tools...` | 2 | **Already-fixed authoring diagnostics.** Same tool-name attribution follow-up; one correlated probe also exercised access to a prohibited/unexposed tool. | `13:56:37/1868582f`, `17:13:08/3863547d` |
| High call-count run | 1 | **Confirmed remaining candidate, evidence only.** The finish record reports 197 nested calls. This is consistent with call-budget/aggregation pressure; it is not evidence that the cap should be raised or effects replayed. | `15:25:24/ddb1cc60` (`toolCalls: 197`, Codex `gpt-6-astra`) |
| No returned result body available | 25 | **Confirmed observability/evidence gap.** The failed finish has `ok:false` and a call count, but the app/provider records do not expose a joinable returned error body for this call. 24 are Codex records and one is a DeepSeek record with a missing correlation ID. | Direct-call examples: `12:11:32/db663c81`, `16:02:12/4914743e`, `16:46:30/a875fd0c`, `2026-09-07 00:03:47/91d25a1b`; nested-call examples: `12:21:13/d4dbb316`, `15:48:24/9839fc88`, `17:14:03/dcce8d25`, `2026-09-07 00:11:55/91d25a1b`; the no-ID record is `23:22:26/none` |
| Sandbox/authoring probe with `require...` | 1 | **Development probe / expected sandbox restriction**, not a production defect. The request was inspecting the sandbox worker; plain JavaScript in this sandbox has no Node `require`. | `2026-09-07 00:05:23/9e931ccd` |
| Unresolved development-probe prefixes (`susp...`, lowercase `unexp...`) | 2 | **Development probes; attribution insufficient.** Both belong to a model-nicknames coding session. The retained log only keeps a 53-character truncated result prefix, so neither is promoted to a runtime-improvement candidate. | `15:25:38/157d1d21` (`unexp...`), `15:25:59/157d1d21` (`susp...`) |
| **Total** | **66** |  |  |

The development/probe label is about workload intent, not another count to add
to the table. The surrounding first-message previews identify engineering and
evaluation work: run-code/session-tool audits, guard review, CI and test
repair, UI/model-menu work, continuation briefings, and independent review.
There is no evidence in this window that these 66 records represent ordinary
end-user task failures.

## What is already closed versus what remains open

The 37 records in the six authoring-diagnostic rows are consistent with the
closed `docs/plans/run-code-authoring-friction.md` work and its diagnostics
follow-up. Specifically, the relevant current seams are the shared
`syntaxErrorDetail` and `runtimeErrorDetail` worker diagnostics,
`isUnsuccessfulRunCodeOutput`, the failure-time compact signature, the
`tools.<member> failed:` nested envelope, and the realm-local unknown-tool
message. These failures are useful as historical evidence, but are not a
request to reopen those fixes.

Two evidence-backed follow-up candidates remain for coordinator triage:

1. **Structured failed-finish observability (25 records).** The finish logger
   currently contributes `ok` and `toolCalls`, while the Codex response log
   does not retain a returned tool body that can be joined to the finish. Five
   records also lack a correlation ID (four syntax-prefix records and one
   no-body record). A future change could emit a bounded error class/path and
   stable run/tool identity without logging script source or full tool output.
   This report does not choose a design or priority.
2. **Call-budget/aggregation recovery (one record).** `toolCalls:197` is the
   only unambiguous high-call-count failure here. Preserve the existing guard
   and effect-safety rule; investigate bounded partial-result/recovery
   diagnostics rather than increasing the cap or replaying completed effects.
   The M4 re-measure gate in the authoring-friction plan remains open.

There is no confirmed timeout class in these 66 records. One failed probe had a
10-second configured timeout, but its returned error body is not available, so
it is not safe to call that a timeout. No default timeout, retry, approval, or
output-cap change is justified by this attribution.

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
the nearest preceding provider response containing a `run_code` function call;
for non-Codex providers, its call ID was then matched to the bounded `role:
tool` message in the subsequent provider request. The projection retained
only the result prefix (for example `Script failed: Inval...`,
`Script failed: Unexp...`, or `Unknown tool: ...`), its length, provider/model,
timestamp, and `toolCalls` count. Full scripts, prompts, tool arguments, and
tool output were not included in the report. Codex has no equivalent joinable
returned body in these app records, which is why those 25 records remain an
evidence gap rather than an invented root-error distribution.

