# Lite merged into Bare

Lite and Bare were both short-prompt profiles. The code already treated them alike:
`isLiteProfile()` matched any Profile with a markdown identity, so Bare received
Lite's prompt and tool branches in `buildPromptSpec()` and `getAgentDefinition()`.
Keeping both meant keeping those branches, the legacy `liteMode` flag, and Lite's
mixed filesystem authority (reads outside the workspace, writes inside it). The
`AgentSpec` scope could not express that mixed authority, so Lite's `run_code`
ran without a root authority snapshot.

## Decision

- `builtin:lite` is removed from the registry. `canonicalProfileId()` in
  `legacy-adapter.ts` maps it to `builtin:bare`. The resolver, `SettingsService`
  (on load and on `setDynamic`), the CLI (`--lite`, `--profile lite`, resumed
  sessions), labels, the guarded `/settings` command, and the gateway (`mode: lite`)
  all canonicalize it. `app.liteMode: true` selects Bare, and Bare projects back to
  `liteMode: true` for older readers of saved sessions.
- Bare carries no tool for what the shell can do. It has no file editors
  (`filesystem-write` removed), no read or search tools, and no `activate_skill`.
  The skills catalog tells the model to read SKILL.md through the shell
  (`getSkillCatalog({ loadVia: 'shell' })`). The sandbox is the write boundary
  for Bare's edits. This was the user's rule, applied after the first review.
- Bare gains `run_code` for what the shell cannot do. The model-facing tools
  are `shell`, `goal_check`, and `run_code`, plus `session_rollover` in
  interactive sessions (prohibited inside scripts, no shell equivalent; kept
  by user decision, as Lite had it); web, memory, sessions, and MCP are
  script-only `tools.*` members.
- Bare gains `background-tasks`. `presentBareShell()` adds the `background` and
  `monitor` shell options only when a background job registry exists
  (interactive roots), and the job get/cancel tools are script-only.
- Bare's `run_code` catalogue renders non-essential tools by name only
  (`catalogOtherTools: 'names'`, implemented in `renderToolsHeader()`). The model
  calls `tools.describe(name)` for the schema. Standard keeps compact signatures.
  With no editors in Bare, every Bare script tool is non-essential.
- AGENTS.md is no longer injected into Bare. `bare.md` tells the model to read the
  checkout's and `~/.agents/` AGENTS.md before working in a checkout. Lite never
  loaded project instructions; this loads them on demand instead.

## Why `run_code` rather than a new dynamic-loading tool

`run_code` already provides a fixed tool list, schemas on demand
(`tools.describe`), validation against the real schema, and approval routing
for nested calls. Adding tools to the request mid-session would change the
cached tool prefix on every load. Three earlier Bare smoke studies (ledger ids
`2026-10-23-bare-run-code-*`) measured `run_code` on Bare's old tool set. They
found the same acceptance results and +9% to +23% catalogue cost, with web,
memory, and sessions not yet included.

## Measured at merge time (fixture provider, chat-completions, headless)

| Surface | Tool JSON chars | System chars |
| --- | --- | --- |
| Lite on `da1d4ad2` | 19,368 | 6,685 |
| Bare on `da1d4ad2` | 6,328 | 2,857 |
| Bare after merge, headless (no background registry) | 8,242 | 2,866 |
| Standard (unchanged) | 29,506 | 17,908 |

These are request-size measurements only. They say nothing about task quality.

## Known gaps

- **`ask_user`:** Bare has no `user-interaction` capability, and scripts cannot call
  `ask_user` (`RUN_CODE_PROHIBITED_TOOLS`). Interactive Lite users lose the
  question prompt; Bare asks in plain text. This was chosen to keep Bare's direct
  surface minimal; `turn-decisions.blackbox.ts` now runs under Standard.
- **File tools:** Bare has no read, search, or edit tools, neither direct nor in
  `run_code`. This is intended: the shell does all three. Edits lose the
  editor diff display and edit-matching repair, and an outside-workspace
  write fails at the sandbox instead of reaching an approval prompt.
- **Task quality:** no model run has measured quality on the merged surface. The
  add-back verification plan (`experiments/bare-profile/addback-verification-plan.md`,
  untracked at merge time) was written against Bare 1.3.0, and its "no
  production profile changes" scope predates this merge.
