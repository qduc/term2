# Task: model nicknames (feature 2 of 2)

Work ONLY in this worktree: /home/qduc/term2/.worktrees/model-nicknames (branch `model-nicknames`).
Do not touch /home/qduc/term2 or any other worktree.

Read AGENTS.md first, plus the skills: `setting-wiring` (mandatory), `terminal-input-ownership`,
`react-ink-testing`, `testing`. This repo is TDD: write failing tests first, then implement.

## Background

Recent commits on this branch (read them: `git log -p -4`) added, in order:
- lazy/early-exit model resolution + deterministic ranking
- explicit `--provider` narrows permanently (never widens)
- a cache-only `peekCachedModels` helper (no network)
- the FAVORITES feature: `agent.favoriteModels`, a leftmost "Favorites" pseudo-tab in the
  model picker, and `ctrl+f` to toggle a favorite.

You are building the SECOND, INDEPENDENT feature: NICKNAMES.

## Keep the two features untangled

Favorites = bookmarking a model. Nicknames = a short user-chosen name for a model.
They must remain independent:
- Nicknaming a model must NOT require it to be favorited, and vice versa.
- Use a SEPARATE settings key from `agent.favoriteModels`. Do not extend or reshape that key.
- Removing a favorite must not delete a nickname, and vice versa.

## 1. Settings

Add `agent.modelNicknames`: a map of short name -> model identity
(`"provider/modelId"`, split on the FIRST `/` — see `source/services/models/model-favorites.ts`,
which solved this exact serialization problem because model ids can themselves contain `/`).
Reuse that module's parsing helpers rather than reimplementing them.

Validation rules to decide and enforce (with tests):
- what characters a nickname may contain (it is typed as a CLI value, so keep it shell-safe)
- nicknames must be unique
- a nickname must not be ambiguous with a real model id or provider id; define and test precedence

Wire the setting per the `setting-wiring` skill (schema, SETTING_KEYS, SettingsWithSources,
defaults, runtime-modifiability, description, category, and the Contract 04 consumer inventory
including its count).

## 2. Resolution: `-m op`

In `source/services/models/model-resolution.ts`, `--model <pattern>` must check nicknames
BEFORE any provider catalog is loaded (alongside the existing favorites fast path), so a hit
costs zero network.

- Define precedence explicitly and test it: exact nickname vs exact real model id vs favorite.
- A nickname whose target model has vanished must NOT hard-fail: fall back to normal catalog
  resolution and warn via the existing `warnings` array (the favorites path already does this
  using `peekCachedModels` — follow that pattern).
- Preserve: the `passthrough` fail-open statuses, the `HARNESS_IDLE_ENV` guard, and the rule
  that an explicit `--provider` narrows permanently.
- A nickname may carry a reasoning-effort suffix (e.g. stored as `:high`), and an inline
  suffix on the CLI (`-m op:low`) must override the stored one. Test this.

## 3. Renaming UI, in the Favorites tab ONLY

`source/components/menu/ModelSelectionMenu.tsx` + `source/hooks/use-model-selection.ts`.

The picker's query row is a fuzzy filter that consumes printable keys, so naming needs a
modifier key and a deliberate input-ownership design. READ THE `terminal-input-ownership`
SKILL BEFORE DESIGNING THIS — a second input mode layered over the filter row is exactly the
hazard it warns about.

Constraint that makes this tractable: nickname editing is available ONLY in the Favorites tab,
where the filter is near-useless (the list is 5-10 items), so that tab can own its input row
for naming without contending with a filter that matters.

- `ctrl+n` on the highlighted row in the Favorites tab starts inline nickname entry.
- Enter commits; Esc cancels and restores the previous state (including filter text and cursor).
- Rejected input (duplicate/invalid nickname) must show why and keep the user in the editor.
- Existing nicknames render on the row.
- `ctrl+f` (favorite toggle), `tab` cycling, and Esc-to-close must all still behave correctly
  while the editor is open — decide who owns each key and test the boundaries.
- Add the binding to the footer hints.
- Do NOT add nickname editing to provider tabs.

## 4. Non-goals

No MRU/recency. Do not change `--provider` semantics, the ranking work, or the favorites
feature's behavior. Do not add a nickname prompt to the `ctrl+f` favorite flow — favoriting
stays a single keystroke with no naming.

## 5. Verification

- Focused tests on every touched file, `tsc --noEmit`, eslint, prettier.
- `pnpm test:related` on changed source files.
- `pnpm test:lane` has PRE-EXISTING unrelated flakiness (a different random file fails per run,
  plus a constant `logging-service.test.ts` ENOENT). Confirm any failure you see is that, not yours.
- Report actual command output, not a summary of it.

Commit in this worktree. End the commit message with:

Claude-Session: https://claude.ai/code/session_01DunEpUz733Dgwxm6XTcB48

When done, write your report to BRIEF-nicknames-report.md in the worktree root.