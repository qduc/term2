# Settings field editor: string/free-form value entry

## Resume here

**Status: active (2026-09-06). Phase A implemented and merged to main; Phase B open (decision-gated).**

Planning baseline: main HEAD `c023fae1` (settings-legacy-debt M0–M4 merged), inspected 2026-09-06.

Origin: the 2026-09-06 settings-UI session (log `1fed346e`) opened with the user's
complaint that entering string-based settings is clunky, and the recorded
long-term design answer (assistant turn at journal seq 11429–18629). This plan is
the follow-on the settings-legacy-debt plan explicitly reserved
("string/free-form value-entry UX ... owned by a separate plan,
`docs/plans/settings-field-editor.md` not yet written") and the menu-system-redesign
plan's non-goal ("do not change settings domain behavior" / "do not rewrite menu
presentation while changing ownership" - ownership settled since Phase 5 + exclusive
menu input merged).

## Why string entry is clunky (verified current code, c023fae1)

A setting value is entered as **text completion inside the chat composer line**, not
as a field. When a menu stack is open, `InputBox` is unmounted and
`MenuSurface` (`source/components/input/MenuSurface.tsx`) owns the boundary; the
`settings_value` frame binds its text into the composer buffer
(`pushChildEffect` in `source/components/input/SettingsMenuSession.tsx`), and the
frame's "value" is `binding.query` - text from `queryStart` to the cursor.

- E1 - **"Filter:" chrome on a value that is not a filter.** `MenuSurface` renders
  `Filter: <binding.query>` for every filterable kind, `settings_value`
  included. The setting key is not shown in that line (the query starts after
  `<key> `), so the user sees a bare `Filter: <typed-text>` with no key context.
- E2 - **Empty picker states.** Free-form strings (no curated suggestions) already
  render a neutral "Type a value" state. But a string setting **with** curated
  suggestions that matches nothing shows the red "No matching values" box even
  though Enter applies the typed text - and the "Custom value" row is only
  inserted when the key has **no** predefined list
  (`filterSettingValueSuggestionsByQuery` gates the unshift on
  `!hasPredefined`).
- E3 - **Coercion before the schema.** `parseSettingValue` converts `"true"` →
  boolean and numeric-looking text → number *before* the key's type is consulted;
  `parseSettingValueForKey` is key-aware only for arrays. A `z.string()` setting
  whose value looks numeric or boolean (a model id `3.0`, a provider flag
  `true`) is coerced and then fails schema validation: "Expected string,
  received number".
- E4 - **Single-line, list grammar.** Home/End and ↑/↓ move the *list selection*
  (`SettingsValueMenuSession` maps `move home/end` to list navigation); text
  editing is only backspace/←/→ (`menu-editor.ts`). For a plain string there is
  no list to move in, and Enter accepts `binding.query` (text up to the cursor),
  so mid-value cursor movement truncates what would be applied.
- E5 - **Apply is a round trip back into the list.** After Enter the frame closes
  to the settings list (parents stay mounted so users can batch changes). For a
  one-off string edit that is an extra navigation step; kept deliberately for now
  (decision D1).

## Design model (recorded 2026-09-06 discussion)

Stop modeling a string value as *text completion inside a chat command*; treat it
as a **field** - a frame-owned draft value rendered and edited like an input field,
with picker behavior reserved for settings that are actually choices.

1. Choose the interaction from the **schema**, not the key: enums/booleans/curated
   presets → picker frame (choice); `z.string()`/`z.number()` → field frame.
2. A field frame owns its text as **draft state**, not a composer binding:
   `{ settingKey, draft, validationError }`, seeded from the current value,
   committed by Enter as one `apply-settings` intent, cancelled by Esc.
3. Field frames get a **text grammar**, not a list grammar: Home/End jump the
   cursor; suggestions render below the field as accessories; an empty completion
   list is never an error state.
4. **Parse type-verbatim**: coerce only when the schema target is number/boolean;
   strings round-trip raw text.
5. **Exit semantics stated deliberately** (D1) instead of accidental.

Precedents in-repo: the **model frame** commits typed custom model ids that are not
in its list; the **provider wizard** owns a draft whose text uses the controller
editor as transient field input and restores the composer on close.

What not to do (from the same discussion): no popup modal with its own input
listener (one raw-key stream); no parallel settings form outside the menu stack;
no curation-only fix.

## Goals

1. Make entering a free-form string setting feel like typing into a field.
2. Make the empty/no-match states honest: a string value is always settable.
3. Make string values round-trip verbatim (no coercion trap).
4. Stage the work so the low-risk surface fixes (A) land before the frame-model
   change (B).

## Non-goals

- No settings-schema/domain changes, no persisted-format changes.
- No change to boolean/enum picker behavior beyond the shared chrome fixes.
- No change to the model frame, mentor-pool frame, or provider wizard.
- No keyboard-ownership changes (field stays inside the menu stack).

## Decisions

- **D1 (exit semantics, decided for A, revisit in B):** Enter applies and returns
  to the settings list (batch edits). Auto-close-to-composer is a B candidate;
  requires a "single change vs batch" affordance decision and a BackPolicy change.
- **D2 (chrome):** the `settings_value` prompt line shows `<settingKey> =` +
  the value text instead of `Filter:` - the key context is currently invisible
  (E1).
- **D3 (neutral-empty rule):** neutral "type a value" state applies whenever the
  schema type is string and the frame has no selectable match (E2); red
  "No matching values" stays for choices (enum/boolean) and invalid numbers where
  Enter genuinely cannot apply the typed text.
- **D4 (grammar rule):** Home/End move the text cursor only in field frames -
  string settings with no curated suggestions (E4). Curated strings keep list
  navigation because their list is still the primary surface (until B).

## Milestones

### A - Surface fixes inside the existing settings_value frame (implemented 2026-09-06)

Contained to the value session, the value menu, the suggestion filter, the parse
function, and MenuSurface's label line; no frame-model change.

- A1 **Schema-aware parsing** - `source/utils/settings-command.ts`
  `parseSettingValueForKey`: when the key's schema type is `z.string()`, return
  the trimmed raw text verbatim (no boolean/number/JSON coercion). Arrays and
  non-string keys parse as today. Fixes E3.
- A2 **Custom value row for curated strings + neutral no-match state** -
  `filterSettingValueSuggestionsByQuery` inserts the "Custom value" row for any
  string key whose typed text matches nothing (drop the `hasPredefined` gate);
  `SettingsValueSelectionMenu` shows the neutral prompt whenever the key is a
  string and the list is empty (D3), with an accurate subtitle for curated keys
  ("no match - Enter applies the typed value"). Fixes E2.
- A3 **Text grammar for free-form strings** - in `SettingsValueMenuSession`,
  when `isFreeFormString` is true, Home/End move the editor cursor to
  `binding.queryStart` / the end of the text, and accept applies the full
  value text (`editor.text.slice(queryStart)`) parsed verbatim instead of
  `binding.query` (which is cursor-truncated, E4). Fixes E4's accept hazard.
- A4 **Value prompt line** - `MenuSurface` renders `<settingKey> =` +
  `binding.query` for `settings_value` frames instead of `Filter: ` (D2).
  Other filterable frames unchanged. Fixes E1.

### B - Field frame (open, decision-gated)

Schema-driven split: introduce a `settings_field` frame kind next to
`settings_value` (or a field interaction state inside the value session) whose
draft is frame-owned state seeded from the current value, rendered as
`settingKey = draft`; completions render below as accessories; Home/End text
grammar for strings and numbers; inline schema validation before commit; D1's
exit semantics re-decided. Precedent: the model frame and provider wizard draft.
Needs its own milestone record here, isolated worktree, and focused suites
(SettingsValueMenuSession, SettingsValueSelectionMenu, menu-system integration).

### C - Shared field interaction (only on second consumer)

If a second frame needs the field pattern, extract the shared interaction the
model frame / provider wizard / field frame all use. Per the architecture skill,
do not extract before there are two callers.

## Worktree and sequencing

Per AGENTS.md: milestone in its own worktree under `.worktrees/`, branched from
local HEAD. A is self-contained; B follows after D1's exit-semantics decision.

## Verification

- Focused: `source/utils/settings-command.test.ts`,
  `source/utils/value-suggestions.test.ts`,
  `source/components/menu/SettingsValueSelectionMenu.test.tsx`,
  `source/components/input/SettingsValueMenuSession.test.tsx`,
  `source/components/input/menu-system.integration.test.tsx`.
- `pnpm typecheck` after A and again after B.
- The string-looking-like-number/boolean regression cases ("3.0", "true") are
  pinned in `settings-command.test.ts` so E3 cannot return.
- Every command above is run before it is recorded; nothing here claims a run
  that did not happen.

## Implementation record: Phase A (2026-09-06)

(Completed by coordinator in `.worktrees/settings-field-editor-a`; merge SHA and
before/after test counts recorded when the milestone lands.)

## Related plans

- `docs/plans/settings-legacy-debt.md` - the survey that reserved this plan.
- `docs/plans/menu-system-redesign.md` - ownership and frame/binding vocabulary
  this builds on.
- `docs/plans/exclusive-menu-input.md` - the input-ownership boundary this must
  not cross.
