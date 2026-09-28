# MiMo v2.6 Flash and Pro: inconclusive coding benchmark

On 2026-09-28, both OpenRouter models ran through term2 at medium reasoning
effort on the same rewound `r-ws-session-lifetime` task. Each had a 900-second
limit and ran sequentially. The candidate workspaces were prepared outside
the repository from a history-free archive at `dbb0c47f~1`; neither workspace
had a `.git` directory or resolved to a Git worktree. The evaluator was kept
outside both candidate workspaces until after execution.

| Candidate | Run | Hidden evaluator | Changed files | New input / cached / output tokens | Calls |
| --- | --- | --- | --- | --- | --- |
| `xiaomi/mimo-v2.6-flash` | TIMEOUT, 900 s | FAIL, 6/8 passed | 0 | 155,042 / 254,112 / 10,187 | 13 |
| `xiaomi/mimo-v2.6-pro` | TIMEOUT, 900 s | FAIL, 6/8 passed | 0 | 214,420 / 1,737,808 / 20,677 | 56 |

The two failing evaluator tests are the baseline's expected red cases: the
socket error listener and the idle-connection lifetime cap. Neither candidate
submitted an edit. The runner exited successfully because it recorded both
timeouts, **not** because either candidate solved the task. The cost collector
found usage but has no price entry for these models, so dollar cost is unknown;
token counts are not a substitute for a priced bill. Blind judging was skipped
because there are no diffs to judge. These results do not identify a better
model, nor establish performance across tasks.

The isolation check only proved that the candidate *working directories* had
no Git ancestry. Flash's tool log shows it probing the host repository path
and Pro attempted `git log` in its non-repository workspace. The host checkout
was not filesystem-isolated from the processes, so absence of exposure to the
host history cannot be proved from the available tool log. Do not promote this
run to a leakage-resistant comparison or ingest it into the public dashboard.
An earlier attempt nested under the repository was also invalid and is not
included here. A future valid retry needs filesystem isolation from the host
checkout, not merely a history-free working directory, before any paid call.

Raw workspaces, statuses, evaluator output, and usage JSON are preserved in
ignored `.coord/bench-r-ws-mimo-valid-20260928/`; its `BENCH-REPORT.md` is the
generated detailed report. No rerun is implied by this record.
