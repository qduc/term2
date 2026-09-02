---
title: Session retrieval seek/tail control cell
status: control run complete; repair comparison not run
---

# Session retrieval seek/tail control cell

This is the controlled counterfactual for the two patterns that crossed the
repeat bar in `docs/research/session-retrieval-observed-usage.md`: invented
numeric/`cN` cursors, and forward-only `session_read` with no tail access.
It follows the same rules as the Pattern 1 scope cell and the 2026-08-31
paired protocol: fixed model/effort, deterministic oracle, exact-ID
verification, no product change from naturalistic logs alone.

## What the cell is allowed to decide

The cell may show that, on the current API, recovering a fact that exists
only in the last projected record of a long predecessor costs many
`session_read` pages and/or `invalid_cursor` from invented handles.

It may not choose the repair. Candidate repairs (tail anchor, numeric
record index, `from: "end"`) stay unshipped until a control run reproduces
the defect shape and a separately labeled repair build is compared on the
same bench and prompt.

## Fixed variables

| Variable | Value |
| --- | --- |
| Model / effort / mode | `codex/gpt-5.6-luna`, medium, standard, YOLO |
| Path | interactive root in Herdr (non-interactive term2 does not register `SessionBrowser`) |
| Workspace | `w1`, same herdr settle rules as `scripts/experiments/session-retrieval-scope-cell.mjs` |
| Project | throwaway bench repo; seed `projectPath` equals that bench so search cannot hit the term2 corpus |
| Predecessor | synthetic conversation JSONL, not an interactive seed (length must be deterministic) |

Rebuild evidence from a result file with the conversation ID recorded there;
raw JSONL stays local user state.

## Fixture

The driver writes one predecessor into
`~/.local/share/term2-nodejs/conversations/<seedId>.jsonl`:

- 30 user/assistant pairs (60 projected records).
- Pair 1's user text identifies the seed. Pairs 2–30 use the user text
  `continue`.
- Assistants 1–29 are ~1,800-character filler blocks that do not contain the
  token. Assistant 30 is the token and nothing else: 32 lowercase hex chars,
  no `oracle-` prefix (that prefix is searchable).
- Invariant, checked by the driver before the cell starts: the token occurs
  once, in the last `assistant_turn`; the concatenated text of all earlier
  projected records is longer than `MAX_SESSION_BROWSER_CHARS` (12,000), so a
  default first page cannot include it.

`session_search` for the token is impossible without already knowing it.
Search for `continue` or the filler phrase returns many earlier records.
The only documented way to reach the token on the current API is to
`session_read` the exact seed ID and walk `nextCursor` to the end — or to
invent a cursor/index that happens to land near the tail.

## Prompt

One interactive message, cwd = bench:

```text
Previous session ID: `<seedId>`.

That session's last assistant message is exactly one 32-character lowercase
hexadecimal confirmation code and nothing else. Recover that code using the
session tools (`session_read` / `session_search` / `session_list`). Report
only the code in your final answer. Do not modify files.
```

The prompt names the exact ID (the sparse-operational pair showed that an
exact-ID read is the intended path) and that the fact is in the last
assistant message. It does not mention cursors, offsets, or `from: "end"`.

## Oracle and defect metrics

Oracle (same pass/fail as the scope cell): the token appears in the cell
session's final assistant text. Walking every page is a valid workaround;
oracle pass does not mean the API is fine.

Defect metrics, recorded by the driver from `tool_started` /
`command_message`:

- `session_read` count, `session_search` count, `session_list` count
- `invalid_cursor` count
- invented cursors: `cursor` present and not matching `^c[0-9a-z]+$`
- schema-boundary failures (`maxChars` > 12,000 or `limit` > 50)
- whether any successful read output contains the token
- `omitted` on the first successful `session_read` of the seed ID (must be
  > 0 if the fixture invariant holds and the agent used default/start)

A useful control reproduces either (a) ≥5 `session_read` calls to reach the
token, or (b) ≥1 invented cursor. If the agent reports the token after one
start-of-session read, the fixture invariant failed and the cell is void.

## How to run

```bash
node scripts/experiments/session-retrieval-seek-cell.mjs \
  --cli /home/qduc/term2/dist/cli.js \
  --bench /home/qduc/.agents/runtime/bench-session-seek-<ts> \
  --label control
```

`--no-cell` writes the bench and seed only. `--skip-seed` reuses the most
recent bench-scoped seed that still contains a 32-hex last assistant.

Run control against the current build first. A repair label is the same
prompt against a later CLI; do not invent that CLI in the same change as
this protocol.

## Replay

## Control result (2026-09-02)

The control ran against the current build from `cc1b29d6` in the isolated
bench `/home/qduc/.agents/runtime/bench-session-seek-20260902`. The synthetic
fixture invariants held (`60` projected records and `52,200` prior
characters), and the oracle passed. Recovering the final record required
eight `session_read` calls: the first returned `omitted: 57`, and the final
read returned `omitted: 0`. No invented cursor, invalid cursor, or
schema-boundary failure occurred. This reproduces the forward-only pagination
cost, but does not by itself select or justify a repair. Full raw evidence,
including the generated token, remains in the local result file
`<bench>/control.result.json`.

```bash
printf '["<cell-session-id>"]' > /tmp/seek-cell-sessions.json
node scripts/experiments/session-retrieval-log-analysis.mjs \
  --sessions /tmp/seek-cell-sessions.json \
  > /tmp/session-retrieval-seek-cell-corpus.json
```

The cell session must pass the three identity checks. The synthetic seed
will not have a provider-traffic index entry and is not part of the
naturalistic manifests.
