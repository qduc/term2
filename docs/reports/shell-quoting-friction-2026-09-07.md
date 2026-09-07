# Shell-probe quoting friction disposition (2026-09-07)

## Decision

**Disposition: no production change and no cleanup.** The historical record
supports a cancelled-worker artifact-accounting error, not a reproduced shell
quoting defect and not evidence that a suspect payload was executed. The
reported `=` and `0)` paths are retained as claims made by the cancelled
worker result, but their creation is not established by a command/result pair.
The current absence check is only a present-state check; it does not prove that
no transient file existed during the earlier worker run.

This investigation did not execute any suspect payload, delete any artifact, or
rerun the original worker commands. The shell examples below are quoted data
from the persisted transcript, not commands to replay.

## Canonical historical evidence

The predecessor transcript is
`~/.local/share/term2-nodejs/conversations/9147e2d3-8a4d-4714-aa55-2d134328ee9e.jsonl`.
The successor transcript is
`~/.local/share/term2-nodejs/conversations/c1a5eb0e-e24d-415d-88f3-40437b1a7895.jsonl`.
Timestamps in the app log are local UTC+7.

### What was actually authored and what settled

The predecessor transcript records the following representative shell calls as
`subagent_tool_started` events. The command text is reproduced as data so the
quoting boundary is visible:

| worker / call | representative command text | runtime result evidence |
| --- | --- | --- |
| `quintic-yew-572` / `call_7bKcbZzkjGxc85Wkyn3mZGF6` (predecessor seq 1209) | `LOGDIR="$HOME/.local/state/term2-nodejs/logs"; files=("$LOGDIR"/term2-2026-09-06.log(N) "$LOGDIR"/term2-2026-09-06.log.*(N) "$LOGDIR"/term2-2026-09-07.log(N)); printf 'files=%s\n' "$#files"; jq -c '...' $files` | App log records a 40 ms settlement with `commandCount:1`, `successCount:0`, `failureCount:1`, `timeoutCount:0`. This is the concrete authoring failure: zsh glob qualifier syntax `(N)` was passed to the shell tool, whose `spawn({shell:true})` path uses the platform default shell rather than the conversational zsh. No `=` or `0)` path appears in the command text. |
| `quintic-yew-572` / `call_aFvFlB8KRUTN2LDB3h4pAgGf` (predecessor seq 1214) | `find "$LOGDIR" ... -print0 \| sort -z \| xargs -0 jq -c 'select(...) | {...}'` | App log records completion after 4,826 ms with `commandCount:1`, `successCount:1`, `failureCount:0`, `timeoutCount:0`. The portable replacement settled successfully. |
| `quintic-yew-572` / `call_sJSdrz44MXqhj07ILKQWwz4v` (predecessor seq 1229) | `find "$LOGDIR" ... -print0 \| sort -z \| xargs -0 jq -r '...' \| tee /tmp/timeout-warning-projection.tsv \| awk ...` | App log records completion at 07:55:12 after 4,600 ms with one success and no failure/timeout. The named TSV exists with 15 data rows (1,617 bytes). This is an observed artifact-writer effect, not a stray-worktree-file effect. |
| `thistle-laurel-293` / `call_4IqAITVDaEO8OlIxlFaoNYAN` (predecessor seq 1223) | `printf ...; jq -c '...' ~/.local/state/term2-nodejs/logs/term2-2026-09-06.log* ... \| tee /tmp/continuity-app.jsonl \| head -100; printf ...; jq -s ... /tmp/continuity-app.jsonl` | App log records completion at 07:54:43 after 7,000 ms. `/tmp/continuity-app.jsonl` exists and is zero bytes. The command's `tee` effect is established; no worktree file named `=` is established. |
| `thistle-laurel-293` / `call_2rr68qg3IyHbUtZmAjWJ4eV9` (predecessor seq 1220) | `rg --no-ignore -n -m 12 'Invalid previous_response_id\|No tool output found\|...' ~/.local/state/term2-nodejs/logs/term2-2026-09-06.log* ...` | App log records a 62 ms settlement with `commandCount:1`, `successCount:0`, `failureCount:1`, `timeoutCount:0`. The worker transcript retains no stderr/result body, so the exact `rg` failure reason is unknown. The command has no redirection that could create `=` or `0)`. |

The exact command arguments and the settlement records are independently
joinable by call ID in the persisted transcript and app log. The worker tool
results themselves are **not** present: each predecessor call appears once as
`subagent_tool_started`, with no corresponding worker `tool_result` before the
context rollover. Therefore a shell lifecycle completion record is not being
mistaken for the command's semantic output.

### The source of the stray-file claim

At the rollover, both workers were cancelled. The successor's canonical
`subagent_completed` records say:

- `quintic-yew-572`: `status: cancelled`, `error: This operation was aborted`,
  and `filesChanged` containing
  `.worktrees/log-timeout-attribution/=` and
  `.worktrees/log-timeout-attribution/0)`;
- `thistle-laurel-293`: `status: cancelled`, `error: Operation aborted`, and
  `filesChanged` containing
  `.worktrees/provider-continuity-friction/=` and `/dev/null;`.

Those records have no successful write result, byte count, inode identity, or
command that names any of those paths. Their `diffStat` entries report zero
added and zero deleted lines for the `=` and `0)` entries. The only settled
commands that can be joined to these workers are the bounded projections and
their `/tmp` outputs above. Thus the evidence distinguishes:

1. **Confirmed artifact-writer effects:** the `tee` commands created the
   documented `/tmp` projection files; their contents and timestamps are
   inspectable without rerunning a probe.
2. **Confirmed shell-authoring/interpreter failure:** the `(N)` glob qualifier
   command failed at the shell boundary, while the immediately following
   `find`/`xargs` form succeeded. This is a non-portable probe command, not
   evidence that the shell created a path named `=` or `0)`.
3. **Unconfirmed stray-file creation:** no persisted command/result pair
   shows a shell command whose redirection or argument expansion targeted
   `.worktrees/.../=` or `.worktrees/.../0)`.
4. **Most supported classification for the path claims:** cancelled-worker
   bookkeeping or
   orchestrator file-change attribution reported paths that were not proven to
   exist. This is a mistaken stray-file claim, not a proven product shell
   defect. A transient historical file cannot be ruled out from present-state
   absence alone.

The `/dev/null` and `/dev/null;` entries are the same kind of metadata warning:
they are not evidence that `/dev/null` was deleted or written as a repository
artifact.

## Effect verification (read-only)

The verification run performed no command replay and no cleanup:

```text
ABSENT  /home/qduc/term2/.worktrees/log-timeout-attribution/=
ABSENT  /home/qduc/term2/.worktrees/log-timeout-attribution/0)
ABSENT  /home/qduc/term2/.worktrees/provider-continuity-friction/=
ABSENT  /home/qduc/term2/.worktrees/provider-continuity-friction/0)
```

The two named worktrees are no longer registered. The current
`shell-quoting-evidence` worktree is clean before this report is added. The
four `/tmp` projection files remain present; they are not removed because the
request forbids cleanup and they are useful evidence of the commands that did
settle.

The verification does **not** support the stronger statement “the historical
files never existed.” It supports only “the paths are absent now.”

## Product-policy check and follow-up

The existing shell guidance in `AGENTS.md` and the shell tool guidance already
forbid complex inline scripts and require command examples to be treated as
data. The later explorer fallback merge `c0656929` additionally keeps `grep`
and `glob` available to read-only explorers when shell search is blocked, and
tests the prompt and role assembly. That addresses the observed search
availability blockage without relaxing shell policy; it does not justify
executing a quoting probe or claim to repair this unproven stray-file report.

No concrete product bug was reproduced, so no reproduction design or
production touch set is proposed. If a future incident supplies a settled
shell command, its result, and an effect identity for a path such as `=`, the
next investigation should classify the boundary that produced it (tool
argument serialization, shell parsing, or artifact bookkeeping) before any
runtime edit. Until then, retain this as an evidence-backed no-change
disposition.

## Queries run

These bounded, read-only queries were run against the named canonical files and
logs while preparing this report:

```bash
jq -r 'select(.event.type=="subagent_tool_started" and
  (.event.agentId=="quintic-yew-572" or .event.agentId=="thistle-laurel-293"))
  | [.seq,.event.agentId,.event.toolCallId,.event.toolName,
     (.event.arguments.command // .event.arguments.path // "")] | @tsv' \
  ~/.local/share/term2-nodejs/conversations/9147e2d3-8a4d-4714-aa55-2d134328ee9e.jsonl

jq -c 'select(.event.type=="subagent_completed" and
  (.event.result.agentId=="quintic-yew-572" or
   .event.result.agentId=="thistle-laurel-293")) | .event.result' \
  ~/.local/share/term2-nodejs/conversations/c1a5eb0e-e24d-415d-88f3-40437b1a7895.jsonl

for f in /home/qduc/term2/.worktrees/log-timeout-attribution/= \
  '/home/qduc/term2/.worktrees/log-timeout-attribution/0)' \
  /home/qduc/term2/.worktrees/provider-continuity-friction/= \
  '/home/qduc/term2/.worktrees/provider-continuity-friction/0)'; do
  test -e "$f" && printf 'PRESENT\t%s\n' "$f" || printf 'ABSENT\t%s\n' "$f"
done
```

The first query returned the representative command texts. Fixed-string counts
for the cited worker call IDs were one occurrence each in the predecessor
transcript, and the app-log settlement records above provide the command
results that survived the worker cancellation. The second returned both
cancelled result objects with zero-line `=`/`0)` diff-stat entries. The final
query produced the four `ABSENT` lines in the effect-verification section.
