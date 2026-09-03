# Local compaction vs session rollover — natural experiment 2026-09-02/03

Date: 2026-09-03. Analysis only; no code changed.
Workload: test-audit M4 coordination — one DeepSeek `deepseek-v4-flash` root
session fanning out to Codex `gpt-5.6-luna` subagents, five chained sessions in
~6h. Settings: `contextCompaction {enabled true, mode auto, threshold 0.8,
thresholdTokens 300000}`; model window 1,024,000 → effective auto threshold
`min(819200, 300000) = 300,000` estimator tokens.

Intent (hints, not truth — code and log win): `docs/plans/
provider-neutral-context-compaction.md` (local compaction = fallback for
providers without native compaction; needs ≥1 complete cold turn) and
`docs/plans/session-rollover-handoff.md` (agent-triggered handoff as *the*
compaction alternative; agent writes brief, successor starts at ~20k).

Premise check first: it is NOT true that compaction contributed nothing. The
log holds 54 `blocked/no_complete_cold_turn` warns AND 6 `dropped
provider-opaque items` debugs — and that debug line fires only after a
`compacted` outcome (`agent-client.ts`, past the `!== 'compacted'` early
return). Score is 6 successes vs 54 blocks, and one success is load-bearing
(see R4). Rollover still carried the larger share.

## 1. Reconstructed timeline

Token figures are provider-reported `prompt_tokens` from the traffic artifacts
(`~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-02/<dir>/`), which
the app log does not carry. Compaction-blocked records carry no sessionId, so
bursts are attributed by era. All times UTC (local +07).

| # | Rollover (UTC) | From → to | Prompt tok at handoff (cached) | Stated reason | Compaction before it |
|---|---|---|---|---|---|
| R1 | 02:19:23 | 8b49b1ea → 7cb809c6 | 205,566 (205,440) | task boundary (M3 work done) | 2 SUCCESSES (00:17, 28 opaque dropped; 01:13, 103 dropped, history 509→139 items). 0 blocks. |
| R2 | 03:06:15 | 7cb809c6 → 75fbce8c | 142,894 (141,824) | task boundary (B1+B2 landed, next B3) | Nothing: 142k never reached the 300k trigger. |
| R3 | 03:54:16 | 75fbce8c → 62b1a56a | 230,787 (229,120) | context pressure (successor briefing) | 33 BLOCKS 03:41–03:54:09, estimator 307k→340k, last block 7s before rollover. Refused-then-rollover, textbook. |
| R4 | 04:46:40 | 62b1a56a → f925c980 | 207,324 (205,312) | context pressure (successor briefing) | 1 SUCCESS 04:27:03 (75 dropped, items 459→381) — helped but not enough, pressure persisted. |
| R5 | — requested 05:18:58, BLOCKED | f925c980 → (none) | 196,780 at request | context_pressure | Request refused: 1 active background shell (`session.rollover.blocked`). SUCCESS 05:21:11 (108 dropped, items 543→292) carried the session instead. The backstop case. |

Successor sessions all restart at ~22k prompt tokens (21.6–22.0k across all
four) — roughly a 10x context cut per rollover for a ~4.7 KB briefing
(`briefSize: 4732` on the R5 request record). History item counts confirm it:
every session's first `Agent stream started` shows `inputItems: 1` (the
briefing alone), then monotonic growth with no mid-session cuts except the two
compaction successes above (509→139, 543→292, 459→381).

Additional era notes: 00:08–00:09 holds 4 `Codex compact endpoint failed`
warns (`reasoning.context must be all_turns` 400s — Luna native compaction
rejected, separate issue, local path unaffected). 07:28 holds a 6th success
(69 dropped) in the unrelated `39c81dd0` session.

Evidence commands:

```bash
LOGDIR=~/.local/state/term2-nodejs/logs
cat "$LOGDIR"/term2-2026-09-03.log* | jq -r 'select(.level=="warn" and ((.message//"")|test("compaction blocked"))) | [.timestamp, (.reason//"?"), (.renderedInputTokens//0)] | @tsv' | sort
cat "$LOGDIR"/term2-2026-09-03.log* | jq -r 'select(((.message//"")|test("dropped provider-opaque"))) | [.timestamp, (.droppedOpaqueItems//"?")] | @tsv'
L=$LOGDIR/provider-traffic/2026-09-02; for D in 16-51-27_8b49b 19-19-23_7cb80 20-06-15_75fbc 20-54-16_62b1a; do for F in $(ls $L/$D | tail -n 1); do python3 -c "import json; e=json.load(open('$L/$D/$F')); u=e['received']['summary']['payload'].get('usage',{}); print('$D', u.get('prompt_tokens'))"; done; done
grep -h "Agent stream started" "$LOGDIR"/term2-2026-09-03.log* | jq -r 'select(.provider=="DeepSeek") | [.timestamp, .inputItems] | @tsv' | sort
```

## 2. `no_complete_cold_turn`: normal state, not edge

`planLocalCompaction` (`context-compaction/index.ts`) requires ≥3 genuine
non-synthetic user turns and cuts before the last two. A rollover successor's
history is `[1 briefing + hundreds of assistant/tool items]` for its entire
life until the user speaks twice more. So after every rollover, compaction is
*structurally* unable to fire — and both blocked bursts (03:41, 05:03) sit in
successor sessions with exactly that shape. All 54 blocks carry the same
reason; zero blocks for any other reason; estimator tokens (307–340k) prove
the threshold was genuinely crossed, so this is the design meeting reality,
not a bug and not a rare edge: **in coordinator-style agentic sessions that
live inside one giant turn, the compactor can almost never fire, which is
exactly the workload that needs it.**

The successes all came from 8b49b (pre-first-rollover, multi-turn shape with
real user exchanges) and from sessions that eventually accumulated more user
turns. The mechanism works when its precondition exists; the precondition is
what agentic use rarely provides.

## 3. Rollover information loss: none detected

What to look for: successors re-reading files or re-deriving facts the
predecessor held. Observed instead:

- Successors orient from disk-backed artifacts, by design: 7cb809c6's first
  actions are `git status/log` + reading the plan doc's M4 section — files,
  not predecessor memory. Re-reading a durable file is not loss.
- Handoffs are deltas on durable state, not the state itself: 3–4 KB briefs
  naming exact commits (e.g. `06dafa96`, `876eb4b3`), batch scopes, and
  pointers (`test-audit-m4-progress` memory, plan-doc batch table). The
  62b1a56a briefing duplicates some memory-held process lessons — redundant,
  not lossy.
- No tool-output re-execution detected: no evidence of a successor re-running
  a reviewer, re-baselining, or re-deriving a decision the predecessor
  recorded. M4 batches B1–B5 landed exactly once each across the chain.

Caveat: the app log's `tool_call.execution_started` carries no tool arguments
(file paths), so a *partial* re-read (same file, new reason) is invisible to
this audit. The cost side is bounded regardless: 22k successor starts vs
140–230k predecessors leaves little room for expensive repetition.

## 4. Races and interleaving: none found, guards held

- Closest adjacency is benign: last R3 block 03:54:09 → rollover 03:54:16.
  Blocked is a no-op, so there is nothing to race; the sequence reads as
  refused-compaction → agent chose rollover.
- R5 is the guard working as designed: rollover refused while a background
  shell was live, and compaction (which needs no such guard — it runs inside
  the request boundary) covered the gap 3 minutes later.
- No compaction-mid-rollover, no discarded just-compacted context, no
  duplicated tool execution across a boundary.

## Recommendation: keep both, with this boundary

- **Rollover owns cross-run continuity** (task boundaries AND pressure
  handoffs — R1/R2 show the former needs no pressure at all). It did the
  heavy lifting here and was lossless.
- **Compaction owns within-run relief plus blocked-rollover backstop.** R5
  alone justifies keeping it enabled in agentic sessions: without the 05:21
  compaction the session had no other relief valve. Do NOT disable compaction
  in agentic sessions on the theory that it "contributes nothing" — the 10x
  rollover cuts make that theory tempting and R5 refutes it.
- **Do not try to make compaction fire in single-briefing histories** (e.g.
  by cutting inside one turn). The whole-turn atomicity + tool-pairing
  invariants are load-bearing; the R3→rollover path is the correct outlet
  for that shape.
- **Fix the observability gap before any further tuning:** compaction
  blocked/success records carry provider+model but no sessionId, forcing
  era-based attribution (as in §1). Add sessionId (and pre/post estimator
  tokens on success) so the next audit need not reconstruct.

If the evidence does not support something: it does not support sizing the
briefing (4.7 KB worked; nothing tested smaller), and it does not say whether
successor sessions *should* chat more with the user to unlock compaction —
that would be optimizing for the mechanism, backwards.
