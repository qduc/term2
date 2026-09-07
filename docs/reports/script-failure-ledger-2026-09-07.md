# Canonical `run_code` failure ledger (2026-09-07)

## Current evidence status

The parent-verified batch-envelope supplement below supersedes the helper's
eight ambiguous joins and one bounded candidate. The helper remains a
historical heuristic scan, not an authoritative identity join. Its aggregate
counts are not recomputed or promoted by this manual correction.

## Scope and accounting

This report is the canonical, deduplicated ledger for the remaining body gaps
from the failed-finish attribution.  It is evidence-only: no application code,
runtime setting, or canonical conversation was changed.

- **Window:** `2026-09-06 07:43:49` through `2026-09-07 07:43:49`, local wall
  time (UTC+7).
- **Application inputs:** `term2-2026-09-06.log`, rotations `.1` through `.15`,
  and `term2-2026-09-07.log` under
  `~/.local/state/term2-nodejs/logs/`.
- **Canonical inputs:** JSONL conversations under
  `~/.local/share/term2-nodejs/conversations/`. Provider-traffic artifacts were
  used only as a corroborating transport source where already identified; the
  persisted conversation `tool_result` is the canonical result source.
- **Record identity:** one application record with
  `message == "run_code execution finished"`, `ok == false`. Rotated-file
  copies are deduplicated by `messageId`. A conversation's
  `tool_started`/journal/settlement copies are one nested call, not multiple
  calls.

The structured scan found 813 finished records in the bounded input (747
successful and 66 failed). The older plan note says 849 total; that denominator
difference is retained as an unresolved logging-scan discrepancy and is not
used below. The failed-record count is stable:

| accounting partition | records | meaning |
| --- | ---: | --- |
| Parent prefix-classified records | 37 | Retained as historical prefix classes; a prefix is not proof that a mitigation resolved the failure. |
| Five recovered records | 5 | Canonical bodies recovered in the preceding evidence work: unavailable-tool lookup, 197-call guard, `require__noop`, `c768...` unexpected-tail, and suspicious-length assertion. |
| **Remaining canonical ledger below** | **24** | 23 Codex records plus one DeepSeek record; 23 have canonical result bodies and one has an exact, reproducible canonical-data absence. |
| **Total failed finishes** | **66** | `37 + 5 + 24`. |

No row is labelled a probe. The surrounding coding, audit, and review work is
not positive fault-injection evidence.

## Remaining-24 canonical ledger

Application paths are the exact `path:line` found by the parser. Conversation
`seq` values are canonical event IDs. For a canonical result, the `failure`
cell quotes the exact first error line and the nested tool-call count; syntax/
location lines are included where present. A nested tool-call count is not
evidence that any external effect occurred. `next observed` quotes the next
canonical call, its event sequence/timestamp, and its result success field. A
next call is evidence of what happened next, not evidence that the overall task
was completed.

| local finish | app record / call ID | canonical conversation event(s) | exact failure and nested tool-call count | next observed outcome |
| --- | --- | --- | --- | --- |
| 2026-09-06 08:44:02 | `term2-2026-09-06.log.6:4023`; `call_eA0kuYTLujV5AV2Cque7dvRt` | `72e06ab7-c604-4148-b01d-f9a49be89de7.jsonl`, seq `84,86` | `Script failed: Unexpected identifier 'formatToolCommand'`; `Line 1: const patch='*** Begin Patch\n...`; `[0 nested tool calls]` | `call_4k6daWmQOsC9SC9FKneX0ajh` (`run_code`): `Result: Updated /home/qduc/term2/source/utils/conversation/conversation-utils.test.ts` |
| 2026-09-06 09:10:21 | `.6:6207`; `call_yM115jeDyFW6J7bEz561zp74` | `d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, seq `2121,2123` | `Script failed: Search failed: rg: regex parse error:` followed by `unclosed group`; `[1 tool call: grep]` | `call_7yUq9mKT5svBpSoRrIOpukGQ` (`run_code`): `Result: 841: ... clearConversations ...` |
| 2026-09-06 10:24:25 | `.8:263`; `call_YA6SJsESph3JhsMwawyW6SMb` | `d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, seq `5647,5649` | `Script failed: Search failed: rg: /home/qduc/term2/.worktrees/rollover-live-work/source/services/session/stream-error-handler.ts: No such file or directory (os error 2)`; `[1 tool call: grep]` | `call_SkQZarQBCmfV3F74nYi8tidN` (`run_code`): `Result: No matches found.` |
| 2026-09-06 10:25:48 | `.8:467`; `call_n8wrw0jUYU48IMXb3HNnitzf` | `d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, seq `5693,5695` | `Script failed: Search failed: rg: /home/qduc/term2/.worktrees/rollover-live-work/source/services/conversation/tool-execution-ledger.ts: No such file or directory (os error 2)`; `[1 tool call: grep]` | `call_ieDo1mUMe1MqWcVOB0FOfVRk` (`shell`): event sequence/timestamp/result success field not retained by the prior projection; `Runtime: 64ms` is timing only |
| 2026-09-06 12:21:13 | `.10:3067`; `call_ldYXK7zMlrogJcWI90WQ8iT3` | `b2799d1a-082e-44f6-9fcc-b913ae9ed3ff.jsonl`, seq `86,88` | `Script failed: Search failed: rg: /home/qduc/term2/source/tools/shell.ts: No such file or directory (os error 2)`; `[5 tool calls: grep×4, read_file]` | `call_otDOxPZBYvgVEu24nty5xuJD` (`run_code`): `Result: [{"status":"fulfilled",...` |
| 2026-09-06 15:26:02 | `.12:836`; `call_z3Y9la0y8uF7TXvBA5tFhdV0` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `92,94` | `Script failed: Cannot read properties of undefined (reading 'length')`; `[1 tool call: read_file]` | `call_03TsiC5XhW2ZTUw8wi7hCeMK` (`run_code`): `Result: "{\"path\":\"/tmp/rc-batch1.json\",...` |
| 2026-09-06 15:26:15 | `.12:867`; `call_Uu8xdF2AYQw2bF8VCjvQZgeH` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `100,102` | `Script failed: Bad control character in string literal in JSON at position 100000 (line 1 column 100001)`; `[1 tool call: read_file]` | `call_jKw9EJtsmYkIE6VlZBfEdFTR` (`shell`): event sequence/timestamp/result success field not retained by the prior projection; `Runtime: 1518ms` is timing only |
| 2026-09-06 15:48:24 | `.12:1974`; `call_bSJE0nclooO4XTSnxUBQ6BCd` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `1670,1672` | `Script failed: Search failed: rg: regex parse error:` followed by `unclosed group`; `[2 tool calls: read_file, grep]` | `call_SdsGNXzjNU4PQrJCNKSKLXZF` (`run_code`): `Result: {"session":{"name":"session_read",...` |
| 2026-09-06 15:54:25 | `.12:2293`; `call_Bysly7TgqHWh31xDmZbv14Qs` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `2007,2009` | `Script failed: Missing initializer in const declaration`; `Line 1: const value: number = 1; return value;`; `[no tool calls]` | `call_i2htcZB7j68KkzPm98AdeQov` (`run_code`): `Result: <skill_content name="herdr">` |
| 2026-09-06 16:02:12 | `.12:2558`; `call_bW1mWQ0rt9tdwMffp8OE7y4u` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `4555,4557` | `Script failed: Script sandbox failed: ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the working directory, uv_cwd`; `[no tool calls]` | `call_2oqMtAM95RICPJlY966jeIuq` (`enter_worktree`): `Error: could not list worktrees (spawn git ENOENT. Is /home/qduc/term2/.worktrees/model-nicknames inside a git repository?)` |
| 2026-09-06 16:03:12 | `.12:2627`; `call_c7iUopsD2IO1qt3gEK0gicBK` | `501344fc-7bb0-4025-b98c-58c697c07486.jsonl`, seq `4579,4581` | `Script failed: Script sandbox failed: ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the current working directory, uv_cwd`; `[no tool calls]` | `call_mZnt9aD4vou6xDhU9CeAid8p` (`shell`): event sequence/timestamp/result success field not retained by the prior projection; `Runtime: 3677ms` is timing only |
| 2026-09-06 16:10:32 | `.12:2821`; `call_6C6a0gXwGfvlHIGmeOyulSc0` | `4595031d-adb6-4c05-84f0-fee400081058.jsonl`, seq `7,9` | `Script failed: Script sandbox failed: ENOENT: process.cwd failed with error no such file or directory, the current working directory was likely removed without changing the working directory, uv_cwd`; `[no tool calls]` | `call_kMM47p2yLeS2V9iHuJ6iFHtz` (`shell`): `2b77b39b Merge docs: record merged commit references for evidence-backed shell timeouts` |
| 2026-09-06 16:46:30 | `.13:437`; `call_dQBZXX6v5f0CUuZDX09cFRsh` | **No matching canonical `tool_started`, `tool_result`, or `command_message` event found.** The provider response is app `.13` and identifies the call; the conversation search over all JSONL files found no canonical lifecycle record. | Exact app evidence: `ok:false`, nested tool-call count `0`, script description `Check the report file writer`; no canonical result or nested tool-call count is available. This is an inaccessible-canonical-data record, not a guessed empty result. | No canonical next outcome. Do not infer that `tools.describe("create_file")` ran. |
| 2026-09-06 17:14:03 | `.13:1484`; `call_qN9UrWGptiukgipO2Kp9wiqq` | `bdd41931-1880-4e2f-8df1-4a053d0dab51.jsonl`, seq `56,58` | `Script failed: Search failed: rg: regex parse error:` followed by `unclosed group`; `[6 tool calls: grep, read_file×5]` | `call_7nt4pYkOb8BcUsck4gz8OEqg` (`run_code`): `Result: [{"status":"fulfilled",...` |
| 2026-09-06 19:50:48 | `.13:4386`; `call_i2GNYuV1raVkpQKWkATNFbmS` | `b42bf6ab-194d-4628-83a3-dfa488ea6e15.jsonl`, seq `1536,1538` | `Script failed: Unknown tool "search_replace". Available: web_search, web_fetch, configure_task_check_in, get_shell_job, cancel_shell_job, cancel_shell_monitor, memory_list, memory_get, memory_create, memory_update, memory_delete, session_list, session_search, session_read, activate_skill, read_file, apply_patch, get_subagent_result, get_subagent_status, send_message, cancel_run`; `[no tool calls]` | `call_F8hWwW17xZeKug6jNKa2tW9N` (`run_code`): `Result: Error: Invalid patch: Patch failed: the context block was not found in the file.` |
| 2026-09-06 23:22:26 | `.14:3587`; `call_00_9lC0n81Efw4FJrnkHEFR5641` | `e90a9686-1bd2-44b2-ab0c-303eb2004716.jsonl`, seq `43665,43667`; direct `assistant_journal_item` tool-call/result pair | Exact journal result: `Script was cancelled. Script was cancelled by its parent\n\n[no tool calls]`; nested tool-call count `0`. The journal result status is `completed` for the wrapper, while its body records cancellation; do not describe this as successful script work. | `call_00_7cKTgBBUkutzyUFGBz2Z5815` (`run_code`), event seq `44390`, timestamp `2026-09-06T16:22:55.494Z`: result event seq `44392`, success `true` for the next wrapper call. The next call is not proof this cancelled script completed. |
| 2026-09-07 00:03:47 | `.log:500`; `call_L6VtJBCo0yMJBEOwomvSxvQK` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `127,129` | `Script failed: tools.grep is not a function`; `[no tool calls]` | `call_hULSsIFWwsvkuXXDmjzH6Xj7` (`run_code`): `Result: [{"path":"/home/qduc/term2/.worktrees/session-tools-pain/...` |
| 2026-09-07 00:05:11 | `.log:630`; `call_PoaPCothPE9GFFoVtK60UOXW` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `155,157` | `Script failed: Unexpected identifier 'kinds'`; `Line 9: +  expect(tools[1]!.description).toContain('Use \\`kinds: ["user", "assistant"]\\`');`; `[no tool calls]` | `call_TRqsn0k1teEkVqhtTxTi9nBx` (`run_code`): `Script failed: Unexpected identifier 'from'` |
| 2026-09-07 00:05:32 | `.log:659`; `call_TRqsn0k1teEkVqhtTxTi9nBx` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `159,161` | `Script failed: Unexpected identifier 'from'`; `Line 11: expect(tools[2]!.description).toContain('without \\`from: "end"\\` the read starts at the first record');`; `[no tool calls]` | `call_lxRhX9zDtu92czuEavMZbgIn` (`run_code`): `Result: Error: Invalid patch: Patch failed: the context block was not found in the file.` |
| 2026-09-07 00:07:24 | `.log:794`; `call_yYsHUCRM3eet5MdIU2lBbPyl` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `183,185` | `Script failed: Invalid or unexpected token`; `Line 10: -      "Search prior locally persisted session transcripts for the current project. ...`; `[no tool calls]` | `call_0FcD5nG8itMsOmUhUpUyByKp` (`run_code`): `Script failed: Unknown tool "search_replace". Available: ...` |
| 2026-09-07 00:07:29 | `.log:805`; `call_0FcD5nG8itMsOmUhUpUyByKp` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `187,189` | Exact body: `Script failed: Unknown tool "search_replace". Available: ...`; `[no tool calls]` | `call_0GeTmhqJILYFnL818Rutk1TF` (`run_code`): `Result: Updated /home/qduc/term2/.worktrees/session-tools-pain/source/services/conversation/session-browser.ts` |
| 2026-09-07 00:11:55 | `.log:1081`; `call_gvmtvSVRscNz02eByDylqtMj` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `251,253` | `Script failed: Invalid parameters for "memory_get": (root): Unrecognized key: "scope"`; `[1 tool call: memory_get]` | `call_tZ9ZHtvM6hUmjb1cPpOLrDqv` (`run_code`): `Result: {"scope":"project","memory":...` |
| 2026-09-07 00:13:37 | `.log:1234`; `call_Dl5y60xboZx3fFuA1A7LJGg0` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `295,297` | `Script failed: Invalid parameters for "memory_get": maxChars: Too big: expected number to be <=12000`; `[1 tool call: memory_get]` | `call_ZeTEz2pVsPUruyTKwj0CmuIS` (`run_code`): `Script failed: Cannot read properties of undefined (reading 'content')` |
| 2026-09-07 00:13:45 | `.log:1255`; `call_ZeTEz2pVsPUruyTKwj0CmuIS` | `eab6ba46-04d8-417d-9657-8de9312d68a3.jsonl`, seq `299,301` | `Script failed: Cannot read properties of undefined (reading 'content')`; `[1 tool call: memory_get]` | `call_ZHJaWz0Tf7CQ0aEthwTOJFiv` (`run_code`): `Result: {"scope":"project","memory":...` |

The row at `00:07:29` intentionally preserves the exact app call ID from the
structured scan: `call_0FcD5nG8itMsOmUhUpUyByKp`. The shortened ID in an earlier
draft (`...H6Xj7`) belonged to the preceding `00:03:47` call and must not be
joined to this result.

## Parent corrections and recovered records

These corrections are part of the ledger boundary even though the records are
outside the remaining-24 table:

1. **`require` correction:** local `2026-09-07 00:05:23` is canonical session
   `34372ad1-9c97-4dbd-9767-b995699af1ef`, call
   `call_7e42ef21c8ec491eb550ed03`, seq `2853–2856`, with exact result
   `Script failed: require__noop is not defined` and `[no tool calls]`. The
   earlier local `00:03:53` success with two calls is a different event and is
   not evidence for this failure.
2. **Unexpected-tail correction:** local `2026-09-06 15:25:38` (canonical
   `08:25:38Z`) is session `ec8bdb0d-1c6f-4617-830d-ade80d5f9758`, call
   `call_c768ab5d208147ddb69fdeab`, seq `49262–49265`, with exact result
   `Script failed: unexpected tail: "();\n    });\n  },\n);\n"` and
   `[1 tool call: read_file]`. It is not `call_52e67f151fda4e16b7f4fb0f`,
   which is the separate local `15:15:39` failure.
3. The other three recovered records are the local `12:11:32` unavailable
   `apply_patch` lookup, local `15:25:24` call-budget guard
   (`call_Z87tN1aiqcK0Qm8ujB4tGkDe`, exact body `Tool call limit reached (200
   calls per script run).`), and local `15:25:59` suspicious-length assertion
   (`suspiciously short: 29924`). They are excluded from the remaining-24 rows
   so that `37 + 5 + 24` remains disjoint.

The `15:26:15` body reports a JSON parse failure at position `100000` while
reading a structured result. That is evidence of a truncated/corrupted read in
this historical record, not a newly discovered copy of the same result-shape
defect: the relevant output/recovery lane was repaired in the actual main-line
commits `209eb350`, `7b6f0234`, `54b45c0a`, `5259d42f`, and `4936252c`.

The three `uv_cwd` rows at `16:02:12`, `16:03:12`, and `16:10:32` all report a
deleted-worktree process current directory. Their following `enter_worktree`
or `shell` observations are not a terminal recovery trace. Establishing
whether the terminal survived and how it recovered requires a separate
workspace/terminal trace; this ledger does not infer recovery from those next
calls.

## Deduplication and reproducibility

The parser in
[`script-failure-ledger-2026-09-07.py`](./script-failure-ledger-2026-09-07.py)
does the following without writing to logs or conversations:

1. Reads the base log and all rotations for the two dates, filters the fixed
   local-time window and `ok:false` finish predicate, and deduplicates app
   records by `messageId`.
2. Joins each finish to the nearest preceding provider response carrying a
   `run_code` function call. Correlated records use `correlationId`; records
   without one use the same local wall-clock second. Message IDs are ordered by
   their embedded epoch; rotation names are only a stable tie-breaker and do
   not fabricate chronology.
3. Searches the complete persisted conversation JSONL corpus for the exact
   nested call ID. Direct `tool_started`, `tool_result`, `command_message`,
   and `assistant_journal_item.item` tool-call/result records are accepted.
   `assistant_turn` embedded transcript/history copies are not counted as new
   calls, and duplicate direct copies are retained for validation.
4. For each direct canonical result, reads the subsequent canonical lifecycle
   to quote the next observed call/result. Missing direct lifecycle records,
   ambiguous joins, and bounded-candidate rows remain explicit; none is
   presented as a proven join.

Commands used:

```bash
python3 docs/reports/script-failure-ledger-2026-09-07.py \
  > /tmp/script-failure-ledger-2026-09-07.json

jq '{failedCount, joins:(.joins|length), matched:([.joins[]|select(.joinStatus == "matched")]|length), ambiguous:([.joins[]|select(.joinStatus == "ambiguous")]|length), boundedCandidate:([.joins[]|select(.joinStatus == "bounded_candidate")]|length), bodyLocated:.validation.bodyLocated, provenJoins:.validation.provenJoin, skippedFiles, validation}' \
  /tmp/script-failure-ledger-2026-09-07.json
```

The complete-corpus rerun returned `failedCount: 66`, `joins: 66`, `matched: 57`,
`ambiguous: 8`, and `bounded_candidate: 1`. It located direct result bodies for
`64` rows; `62` rows have explicit failure evidence, but only `54` are
`provenJoin` rows: body location is not proof that the app failure and
canonical result are the same execution. The bounded
candidate is the historical five-second candidate-window heuristic; it is not
reported as an absent execution start, and a long-running script remains
explicitly unresolved. `skippedFiles` was `[]`.

The eight rejected ambiguous joins and their candidate call IDs are:

| failed finish message ID | candidate call IDs |
| --- | --- |
| `msg-1788660621958-23f61a` | `call_nKkSeiyMyVvarDrQqCB5vOpz`, `call_yM115jeDyFW6J7bEz561zp74` |
| `msg-1788673922975-djoeb0` | `call_00_P1ODVphrL3rZHURPqE3s0169`, `call_00_YTOZBlFRiu9gyf0fOrch3988` |
| `msg-1788675672809-puz2gg` | `call_00_00UKLTxf9lyy3CTalgJv8306`, `call_00_YCjzCRDoF7tzSnulhiwb4046` |
| `msg-1788675677609-7xa0yx` | `call_00_00UKLTxf9lyy3CTalgJv8306`, `call_00_L9RQdixozCQCzG8o2vh10532` |
| `msg-1788684376749-5t0nps` | `call_4c77fe54d7d54e668d51d8cb`, `call_972c2b14de1f46429ed9859a` |
| `msg-1788710661792-w9bm8u` | `call_00_6JWl0Cq9Uze4293OquZL1108`, `call_00_ET_cEECACPi4mZ2YICJmWQt0890` |
| `msg-1788714449734-aq0j4q` | `call_0FcD5nG8itMsOmUhUpUyByKp`, `call_yYsHUCRM3eet5MdIU2lBbPyl` |
| `msg-1788715575319-s7b3b0` | `call_6b1de638594149f7b62c7a55`, `call_8b451af798d94f73b580be57` |

The one bounded candidate is failed finish
`msg-1788708986902-bvdbay`, candidate `call_01_uhsdcBHyxTa4gqqBLcZ40270`.
Its canonical rows may be inspected, but the helper does not promote the
long-running execution across the bounded candidate window to a proven join.

The journal lane changed the prior apparent absence at `23:22:26` to a direct
`assistant_journal_item` call/result pair. The `16:46:30` row remains an exact
canonical absence in the report table; this scan does not turn missing data
into a successful or failed result claim.

Final receipts for this bounded repair:

```text
python3 docs/reports/test-script-failure-ledger-2026-09-07.py
Ran 7 tests in 0.003s — OK

python3 docs/reports/script-failure-ledger-2026-09-07.py > /tmp/script-failure-ledger-2026-09-07.json
jq '{failedCount, joins:(.joins|length), matched:([.joins[]|select(.joinStatus == "matched")]|length), ambiguous:([.joins[]|select(.joinStatus == "ambiguous")]|length), boundedCandidate:([.joins[]|select(.joinStatus == "bounded_candidate")]|length), bodyLocated:.validation.bodyLocated, provenJoins:.validation.provenJoin, skippedFiles, validation}' /tmp/script-failure-ledger-2026-09-07.json
failedCount 66; joins 66; matched 57; ambiguous 8; boundedCandidate 1;
bodyLocated 64; provenJoins 54; skippedFiles []
```

## Parent-verified batch-envelope supplement

The coordinator independently read the exact app dispatch/start/failed-finish/
settlement envelopes for these nine records. Each envelope dispatches one call,
contains the failed finish under the same correlation, and settles that same
call. These are identity joins, not nearest-response or five-second guesses.
App paths below are under the log directory specified above; `.6`, `.11`,
`.12`, and `.14` mean rotations of `term2-2026-09-06.log`, while Sept 7 means
`term2-2026-09-07.log`. Batch IDs are scoped to their correlation/envelope, not
globally unique. The original failed message IDs above remain the row keys.

| Failed message ID | App envelope; batch | Verified call ID | Canonical session / result seq; failure |
| --- | --- | --- | --- |
| `msg-1788660621958-23f61a` | `.6:6203-6208`; 79 | `call_yM115jeDyFW6J7bEz561zp74` | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`, 2123; regex unclosed group, one grep |
| `msg-1788673922975-djoeb0` | `.11:1018-1023`; 101 | `call_00_P1ODVphrL3rZHURPqE3s0169` | `c6ffa98b-d973-43f4-bab2-999b49a60b3e`, 2000 at `05:52:02.976Z`; undefined `.split`, one read_file |
| `msg-1788675672809-puz2gg` | `.11:1462-1467`; 144 | `call_00_00UKLTxf9lyy3CTalgJv8306` | `12c58dce-7a18-4124-9cf7-4908bd1440dc`, 11510 at `06:21:12.810Z`; session_read rejects from:end with cursor, two session_read calls |
| `msg-1788675677609-7xa0yx` | `.11:1471-1476`; 145 | `call_00_L9RQdixozCQCzG8o2vh10532` | same `12c58dce` session, 11756 at `06:21:17.610Z`; undefined `.slice`, one session_read |
| `msg-1788684376749-5t0nps` | `.12:1740-1745`; 146 | `call_972c2b14de1f46429ed9859a` | `ec8bdb0d-1c6f-4617-830d-ade80d5f9758`, 65653 at `08:46:16.750Z`; session_search rejects sessionId, one session_search |
| `msg-1788710661792-w9bm8u` | `.14:2591-2596`; 227 | `call_00_6JWl0Cq9Uze4293OquZL1108` | `ddf87a17-4e3b-4d55-a0e4-12e2ee9b5047`, 605 at `16:04:21.793Z`; session_read maxChars exceeds 12000, one session_read |
| `msg-1788714449734-aq0j4q` | Sept 7:801-806; 51 | `call_0FcD5nG8itMsOmUhUpUyByKp` | `eab6ba46-04d8-417d-9657-8de9312d68a3`, 189; unknown search_replace, no nested calls |
| `msg-1788715575319-s7b3b0` | Sept 7:1563-1568; 57 | `call_8b451af798d94f73b580be57` | `34372ad1-9c97-4dbd-9767-b995699af1ef`, 27493 at `17:26:15.320Z`; rg rejects look-around, one grep |
| `msg-1788708986902-bvdbay` | `.14:514-517`; 76 | `call_01_uhsdcBHyxTa4gqqBLcZ40270` | `78bb681e-6883-4743-936a-5ae814a2d099`, 1944 at `15:36:26.902Z`; session_read rejects from:start, one session_read |

Canonical timestamps in this table are UTC on 2026-09-06. The final row has
a direct assistant_journal_item call at seq 1939, result at 1944, and a
command_message with success:false at 1945. Its exact first error line is
`Script failed: Invalid parameters for "session_read": from: Invalid input: expected "end"`.
The temporary helper output had incorrectly proposed the earlier successful
`call_00_rIbF3H5KxtmulKIqGhox8003`. Both the proposed identity and the
subsequent claim that the true direct result was absent were rejected by the
parent. No helper-derived aggregate is upgraded from this correction.

Disposition: these nine records establish argument/schema, result-shape,
unavailable-tool, and regex authoring failures; they do not establish a new
runtime defect. The relevant shipped diagnostics and tool guidance are
mitigations, not proof of successful later work or absence of recurrence.
No relaxation of validation or automatic replay follows from this evidence.

## Historical deleted-cwd recovery boundary

The separate terminal trace found successful shell activity after the three
uv_cwd failures, but no successful run_code recovery in the inspected source
and successor trace. Source session `501344fc` recorded successful `pwd` in
rc-contract-repair (seq 4562-4565), an intact worktree listing without
model-nicknames (4566-4569), recreation of that pathname on rc-session-anchor
(4570-4573), then another failed run_code check (4579/4581). Successor
`4595031d` explicitly rolls over from that source and still fails run_code at
seq 7/9. Successful subsequent git, terminal-agent inspection and tests
establish terminal continuity only.

The traced repair agent was agy-rc-fix, pane w1:p2V, terminal
term_65accbf14926f145, in rc-contract-repair. A prior pane listing showed
two term2 processes rooted in model-nicknames, but the inspected sessions
contain no deleting command or deleting owner identity. The narrative that
another session removed it is not an independently joined removal event.
Recreating a pathname is not evidence of repairing a deleted process cwd.
Current shared-host startup reproduction/repair is a separate implementation
lane; the workspace-publication ordering fix 2e935e2f does not close this case.

This report does not infer task success, semantic correctness of prior work,
mitigation adequacy, timeout behavior, or effects beyond the exact canonical
tool-call-count summaries. No production validation was required for this
read-only evidence artifact.
