# Own-session rollover check 2026-09-04 — no bug, behaviour correct

Question: this pane sits at ~363k input tokens with no rollover; are both context mechanisms inert?

## Headroom

- This session is provider-traffic dir `2026-09-03/00-53-28_39c81`: provider `openrouter`, model `meta/muse-spark-1.3-contributor`, 480 artifacts, max observed `prompt_tokens` 363,303 (matches the reported 363k).
- Catalog lookup `getCatalogModel('openrouter','meta/muse-spark-1.3-contributor')` returns UNDEFINED (catalog only knows `muse-spark` up to 1.2; verified via node against built catalog). Nearest sibling `meta/muse-spark-1.2-contributor` declares `contextWindow: 1048576`. If 1.3 matches its family, 363k is ~35% of window — genuinely fine, not near the wall.
- Configured trigger is NOT window-relative: `agent.sessionRollover` defaults `enabled: true, milestones: [200000, 300000, 400000]`, plus `RECONSIDERATION_INTERVAL_TOKENS = 50_000` after any fired milestone (`source/services/agent-runtime/context-compaction/context-milestone-reminder.ts`, `source/services/settings/settings-schema.ts:149-155`). No percentage-of-window logic exists anywhere in the path.

## Rollover DID fire — four reminders injected, verified in `sent` payloads

| First injected at | Reported tokens | Trigger |
|---|---|---|
| 01-46-15.748Z_8b03a | 200171 | crossed milestone 200000 |
| 01-53-48.948Z | 250587 | reconsideration after deferral |
| 02-16-07.183Z | 300094 | crossed milestone 300000 |
| 02-28-24.373Z | 350429 | reconsideration after deferral |

Method: scanned `sent` bodies across all 480 artifacts for `crossed rollover milestone` / `reconsideration after deferral`; each appears as a `[Mode Notice] user`-role message starting the very next request after the crossing (e.g. 200171 observed in `01-46-10.463Z_2a5eb.json`, notice present in `01-46-15.748Z_8b03a.json`). The 350429 notice is the one quoted in the current user turn — the mechanism is talking to us right now.

What did NOT happen is the `session_rollover` tool call — and that is by design. The notice text is advisory ("Rollover remains optional at every later reminder"); the agent never found a safe natural boundary in continuous queued work, so it deferred, and the 50k reconsideration cadence worked exactly as coded. No gating condition analogous to `no_complete_cold_turn` exists in `ContextMilestoneReminder.observe` — the only gates are `enabled`, finite tokens, per-milestone once-per-session. Unknown catalog does NOT suppress reminders (only the compaction-deferral return, which correctly yields `undefined` when `contextWindow` is unknown).

## Native compaction correctly inert here

`supportsContextCompactionModel` (`source/providers/openai-responses-model.ts:255-262`) allow-lists only `gpt-5.4/5.5/5.6` + `gpt-5.3-codex`. This session runs DeepSeek chat Completions over OpenRouter, so no `compaction_trigger` is ever sent — expected, not a bug. The merged `reasoning.context` fix touches only the Codex Responses path and is irrelevant to this pane. The running process (pnpm global `@qduc/term2@0.20.0`, dist built 2026-09-03 09:06) DOES contain the milestone code — verified class body in dist — and the 01:46+ injections prove it executes.

## Verdict

No bug. Limit: unknown to the catalog (assumed ~1M by family, 363k ≈ 35%). Trigger: absolute milestones 200k/300k/400k + 50k reconsiderations — all firing on schedule; next fires at 400k. The only genuine gap is catalog coverage for `muse-spark-1.3-contributor` (no window/pricing), which leaves compaction-deferral blind but does not affect reminders. Not fixing under standing authorization: catalog values for a third-party model need a trusted source, and nothing is broken — recording as an observation, not a change.
