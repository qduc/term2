# Representative `run_code` failure evidence (2026-09-07)

## Purpose and boundary

This is a bounded canonical-evidence follow-up to
[`run-code-error-attribution-2026-09-07.md`](./run-code-error-attribution-2026-09-07.md).
It traces exactly the three requested records from the application log to the
persisted session and, where useful, the provider-traffic artifact. It does not
recount the 66 records, estimate a rate, or claim that the current mitigation
is adequate. No probe or fault-injection label is assigned: none of these
three records has positive evidence of deliberate fault injection.

Application timestamps below are local wall time (UTC+7). Conversation and
provider-traffic timestamps are UTC; the conversion is shown in each case.
`tool_started` plus its journal/settlement copies is one call, not multiple
calls.

## Three-case ledger

| representative | canonical join | exact sanitized failure body | collected effects/progress | next response | bounded conclusion |
| --- | --- | --- | --- | --- | --- |
| **2026-09-06 12:11:32**, correlation `db663c81-8b45-4d5d-902f-28a00d59fbba` | App `.10:2581-2588`; app response request `4c8f831d-1cfe-4866-83cb-4f0295964bec`; session `7754cac2-d195-41a5-9466-11d463942d2b`; conversation seq `827-830` at `05:11:32Z`; traffic response `04-46-29_7754c/05-11-25.519Z_4c8f8.json` | `Script failed: Unknown tool "apply_patch". Available: web_search, web_fetch, configure_task_check_in, get_shell_job, cancel_shell_job, monitor_shell_job, cancel_shell_monitor, memory_list, memory_get, memory_retrieve, memory_synthesize, memory_create, memory_update, memory_delete, session_list, session_search, session_read, activate_skill, read_file, grep, glob, create_file, search_replace, get_subagent_result, get_subagent_status, send_message, cancel_run` followed by `[no tool calls]`. The failed call was `call_mkHP6geAXMsC9QYSXRm5I1xk`, with code `return await tools.describe('apply_patch')`. | The script performed no nested tool call (`toolCalls:0`), so it collected no script-side effect or progress. The preceding session had unrelated settled work, but that is not an effect of this failed script. | Conversation seq `831-834` shows the model immediately issued `rm .worktrees/rollover-hook.patch` via the separately exposed `shell` tool. Provider request `e43dc4aa-6681-42f8-80bb-08d2957d43a7` at `05:11:32.741Z` carries the exact failed tool result; its response at `05:11:48.887Z` contains the cleanup call. | **Confirmed class:** unavailable tool lookup, not a timeout or provider transport failure. The body names the exposed-tool boundary. It does not establish a product bug: `apply_patch` was not in the available list, and the next model action used an available tool. |
| **2026-09-06 15:25:24**, correlation `ddb1cc60-3b56-4a3d-9bb7-7c2170959aab` | App `.12:760-769`; app response request `1e80c280-e9f2-4725-a004-584ffd9ed447`; session `501344fc-7bb0-4025-b98c-58c697c07486`; conversation seq `75-78` at `08:25:23-24Z`; traffic response `08-23-37_50134/08-25-08.507Z_1e80c.json` | `Script failed: Tool call limit reached (200 calls per script run).` followed by `[197 tool calls: glob, grep×196]`. The call was `call_Z87tN1aiqcK0Qm8ujB4tGkDe`; its code attempted a broad conversation scan and only reached the later `create_file` after the loop. | The 197 calls are specifically one `glob` and 196 `grep` calls. The script did not reach `create_file`, so its intended `/tmp/run-code-usage-sep5-6.json` write did not occur. The completed reads were in-memory collection work; no canonical evidence shows a mutation in this failed run. | Conversation seq `79-82` shows the model changed strategy: it bounded the file-list preparation and successfully created `/tmp/rc-files.json` with `call_1YJ8LDKDGgq4SDyiURdLiJxD`. Traffic request `f7e9ac71-6584-4465-9924-4df58281db3c` at `08:25:24.989Z` carries the exact failed result; its response at `08:25:31.559Z` is successful. | **Confirmed class:** the script call-count guard fired at its documented 200-call ceiling. `197` is an observed nested-call count, not evidence of budget exhaustion, provider failure, or a limit that should be raised. The guard gave a concrete recovery boundary, and the next response made bounded progress; this single case does not establish general mitigation adequacy. |
| **2026-09-06 15:25:59**, correlation `157d1d21-a0d8-40f3-90c0-7ccbf9440a50` | App `.12:821-830`; app response request `54546ac4-985a-4c6c-8e8e-198c1aca5adb`; session `ec8bdb0d-1c6f-4617-830d-ade80d5f9758`; conversation seq `49911-49916` at `08:25:59Z`; traffic response `07-53-56_ec8bd/08-25-38.365Z_54546.json` | `Script failed: suspiciously short: 29924` followed by `[2 tool calls: read_file×2]`. The code successfully awaited two `read_file` calls, concatenated their strings, then threw because of the local `full.length < 30000` assertion. This is not a nested `read_file` error. | The two reads produced data, but the script threw before `create_file`/`search_replace`; no write or other script-side effect is evidenced. The failure was an authoring sanity-check false positive against a 1,033-line, 29,924-character file. | Conversation seq `50075-50085` shows the model recognized that 29,924 characters was plausible, reran with a line-count check, and successfully overwrote the test file via `call_03b6b0e6e6ae4297817e896b`. Traffic request `e5b177a0-d6bc-4161-a26d-6710f2ec6c16` at `08:26:09.798Z` carries the exact failed result and its response at `08:26:34.948Z` carries the next call. | **Confirmed class:** model-authored validation/assertion failure after successful reads. It is not a timeout, nested tool failure, or provider transport failure. The next response corrected the assumption and progressed, but this case alone does not establish that the diagnostic mitigation is adequate. |

## Canonical evidence details

### 1. Unavailable `apply_patch` lookup

The application record at `term2-2026-09-06.log.10:2581` identifies the full
correlation, session, request, and `run_code` call. The finish record at
`:2587` says `ok:false` and `toolCalls:0`; it contains no result body, which is
why the earlier projection classified it as a body gap.

The canonical conversation event is
`~/.local/share/term2-nodejs/conversations/7754cac2-d195-41a5-9466-11d463942d2b.jsonl`
seq 830. The canonical provider request immediately after settlement is
`provider-traffic/2026-09-06/04-46-29_7754c/05-11-32.741Z_e43dc.json`; its
`.sent.body.input` contains the exact `function_call_output` for
`call_mkHP6geAXMsC9QYSXRm5I1xk`. The recorded provider response is HTTP/status
200 with zero `errorFrames`, zero `malformedFrames`, and zero `unknownFrames`.
The provider's tool call itself was therefore received normally; the failure
was produced by the local script/tool namespace.

### 2. Call-count guard at 197 nested calls

The app response at `term2-2026-09-06.log.12:760` contains the complete script
call and the app finish at `:766` records `ok:false`, `toolCalls:197`. The
conversation's `tool_result` at seq 77 preserves the body that the application
projection omitted. The next request artifact
`provider-traffic/2026-09-06/08-23-37_50134/08-25-24.989Z_f7e9a.json` carries the
same body in `.sent.body.input` for `call_Z87tN1aiqcK0Qm8ujB4tGkDe`. Its
response was status 200 with no provider, malformed, or unknown frames.

The successful recovery was not inferred from a later `ok` count: conversation
seq 79-82 records the changed bounded call and its successful `create_file`
result directly. The failed script itself never reached that write.

### 3. Suspicious-length assertion

The app records at `term2-2026-09-06.log.12:821-830` identify the full join and
the `ok:false`, `toolCalls:2` finish. Conversation seq 49914-49916 records the
two `read_file` calls, then seq 49916's tool result records the exact body. The
provider artifact
`provider-traffic/2026-09-06/07-53-56_ec8bd/08-26-09.798Z_e5b17.json` carries
that same result in the next request's tool-message history and records the
next successful model response. The failed request's own artifact
`08-25-38.365Z_54546.json` records the two `read_file` calls and status 200,
with no provider error frames.

The successful retry at conversation seq 50082-50085 proves only this local
episode's next-step recovery. It is not post-fix evidence for all script
failures.

## Causal candidates and unknowns for the parent

These three canonical records do **not** confirm a shipped-runtime defect:

1. `apply_patch` was requested through `tools.describe`, but the canonical
   available-tool list did not include it. Candidate cause: the model expected
   a tool surface that this session did not expose. Whether that mismatch is
   intentional policy or a separate product issue is outside this ledger.
2. The 197-call case is a successful guard activation, not budget exhaustion.
   The attempted broad scan was not completed and no side effect from the
   failed run is evidenced.
3. The `susp...` case is a model-authored length threshold that rejected a
   successful read result. It is an authoring false positive, not a nested
   tool failure.

Unknowns remain deliberately bounded: this sample cannot establish recurrence
rates, task-level success, whether any earlier unrelated work was semantically
correct, or whether current diagnostics/guards are adequate after their
respective merges. No timeout, provider transport, or deliberate probe class
is supported by these three canonical records.

## Reproducible bounded queries

The following read-only queries were used (paths are intentionally narrowed to
the identified files and sessions):

```bash
rg -n '"timestamp":"2026-09-06 12:11:32"|"call_mkHP6geAXMsC9QYSXRm5I1xk"|"message":"run_code execution finished".*"ok":false' \
  ~/.local/state/term2-nodejs/logs/term2-2026-09-06.log.10
```

```bash
jq -c 'select(.ts >= "2026-09-06T05:10:45" and .ts <= "2026-09-06T05:12:00") |
  {seq,ts,event:(.event | {type,toolCallId,toolName,callId,status,output,arguments,message})}' \
  ~/.local/share/term2-nodejs/conversations/7754cac2-d195-41a5-9466-11d463942d2b.jsonl
```

```bash
jq -c '{sent:(.sent|{requestId,sessionId,timestamp,input:((.body.input // []) |
  map(select(.type=="function_call_output")) | map({call_id,output}))}),
  received:(.received|{timestamp,status:(.summary.status),transport:(.summary.transport),
  errorFrames:((.summary.errorFrames//[])|length),malformed:((.summary.malformedFrames//[])|length),
  unknown:((.summary.unknownFrames//[])|length)})}' \
  ~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/04-46-29_7754c/05-11-32.741Z_e43dc.json
```

Equivalent narrowed `rg`/`jq` projections were run for app `.12` and the two
other session/traffic identities listed above; no tests, full-suite run, or
runtime modification was performed.
