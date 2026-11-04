# Menu port report: legacy menus in term2-next

The legacy menu stack and its menu sessions were copied into `rewrite/src/clients/tui/menus/`.
The stack is MenuStackHost, MenuSurface, menu-controller, menu-bindings and the trigger rules.
The sessions are Model, Settings, SettingsValue, Resume, Rewind, Profile, Provider, Slash, Path, Skills, Copy, SubagentPool and MenuContainer.
Only their data access was changed: it now goes through `TuiIntegration` (`clients/tui/integration.ts`), which `rewrite/src/app/direct-launch-tui-menus.ts` implements.
The rewritten pickers were deleted: model, settings, effort, resume, rewind, and the picker host.

## How this was measured

`rewrite/scripts/menu-compare/screen.py` runs both CLIs in a pty and captures the screen with pyte, keeping per-cell colour and attributes.
The legacy CLI is `dist/cli.js` and term2-next is `rewrite/dist`.
Each run gets:
- a fresh scratch HOME and XDG tree;
- the same seeded settings file;
- a fake OpenAI-compatible provider. It lists models and can play scripted replies and tool calls.

```sh
pnpm install && pnpm build && node rewrite/scripts/build.mjs
python3 rewrite/scripts/menu-compare/screen.py compare 100 34          # every scenario
python3 rewrite/scripts/menu-compare/screen.py compare 80 24 settings  # named scenarios
python3 rewrite/scripts/menu-compare/screen.py run next 100 34 model   # print one capture
```

The scenarios live in `scenarios_*.py`.
A branch is **identical** when every screen row is equal after masking, both text and cell styles.
The masks cover only:
- the version string;
- session ids (next's ids carry a `conv_` prefix);
- timestamps;
- the scratch path;
- the fake provider's port;
- durations.

## Result

**221 of 244 branches are identical at both 100x34 and 80x24.**
Those counts are from the build rebased onto main.
The other 23 fall into two groups:

- **Dropped by scope.** These cover the Plan, Pair, Mentor and Orchestrator profile rows, and the slash commands that serve dropped features: MCP, ACP, sandbox, and those profiles.
  - The profile list has fewer rows (4 branches).
  - The slash list is shorter, so its scrollbar thumb is one row longer (3 branches). At 80x24 this also moves the `slash-pgdn` page.
- **The first-run settings artifact (16 branches).** "Smart reasoning effort" reads `default` instead of `(default)` in the settings and subagent-pool captures.
  - Cause: term2-next writes a full settings file at launch, and each later session reloads it. Legacy's migration then copies `agent.mentorReasoningEffort` into the smart effort key, so the value shows as set.
  - In a second run, where the key already exists in the file on both sides, the screens are identical. That is the `settings-second-run` scenario.
  - The artifact comes from next's start-up settings write, not from the ported menu.

Branches marked "identical after masking" count as identical. Their text matches, but at 80x24 the masks can't reach part of a value:
- A session id that wraps across two rows escapes the id mask (`resume-*`).
- The truncated scratch path escapes the path mask (`settings-tab2`).
Both are identical at 100x34, where nothing wraps.

`pool-add-done` once differed under parallel load. It is identical in two solo runs, so it counts as identical.

## Branch table

### /auto-approve

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `auto-approve` | identical | identical |

### /copy

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `copy` | identical | identical |
| `copy-bad` | identical | identical |
| `copy-down` | identical | identical |
| `copy-enter` | identical | identical |
| `copy-esc` | identical | identical |
| `copy-far` | identical | identical |
| `copy-menu` | identical | identical |
| `copy-nothing` | identical | identical |
| `copy-single` | identical | identical |

### /effort

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `effort` | identical | identical |

### /help

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `cmd-tasks` | identical | identical |
| `help` | identical | identical |

### /profile

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `profile` | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent |
| `profile-bare` | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent |
| `profile-enter` | identical | identical |
| `profile-esc` | identical | identical |
| `profile-filter` | identical | identical |
| `profile-none` | identical | identical |
| `profile-open` | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent |
| `profile-retired` | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent | dropped by scope: Plan, Pair, Mentor and Orchestrator rows absent |

### /providers

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `prov-delete` | identical | identical |
| `prov-delete-esc` | identical | identical |
| `prov-delete-up` | identical | identical |
| `prov-discard` | identical | identical |
| `prov-discard-no` | identical | identical |
| `prov-discard-yes` | identical | identical |
| `prov-edit` | identical | identical |
| `prov-edit-down` | identical | identical |
| `prov-edit-esc` | identical | identical |
| `prov-edit-key` | identical | identical |
| `prov-edit-name` | identical | identical |
| `prov-edit-type` | identical | identical |
| `prov-edit-url` | identical | identical |
| `prov-list` | identical | identical |
| `prov-list-down` | identical | identical |
| `prov-list-esc` | identical | identical |
| `prov-presets` | identical | identical |
| `prov-presets-down` | identical | identical |
| `prov-presets-esc` | identical | identical |
| `prov-presets-filter` | identical | identical |
| `prov-review` | identical | identical |
| `prov-review-esc` | identical | identical |
| `prov-review-up` | identical | identical |
| `prov-wizard-key` | identical | identical |
| `prov-wizard-key-typed` | identical | identical |
| `prov-wizard-name` | identical | identical |
| `prov-wizard-name-bad` | identical | identical |
| `prov-wizard-name-esc` | identical | identical |
| `prov-wizard-name-typed` | identical | identical |
| `prov-wizard-type` | identical | identical |
| `prov-wizard-type-down` | identical | identical |
| `prov-wizard-url` | identical | identical |
| `prov-wizard-url-bad` | identical | identical |
| `prov-wizard-url-typed` | identical | identical |

### /resume

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `resume` | identical | identical |
| `resume-bare` | identical | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |
| `resume-down` | identical | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |
| `resume-empty` | identical | identical |
| `resume-enter` | identical | identical |
| `resume-esc` | identical | identical |
| `resume-filter` | identical | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |
| `resume-filter-none` | identical | identical |
| `resume-list` | identical | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |
| `resume-pgdn` | identical | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |

### /rewind

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `retry-last` | identical | identical |
| `rewind` | identical | identical |
| `rewind-empty` | identical | identical |
| `rewind-enter` | identical | identical |
| `rewind-esc` | identical | identical |
| `rewind-far` | identical | identical |
| `rewind-junk` | identical | identical |
| `rewind-long` | identical | identical |
| `rewind-number` | identical | identical |
| `rewind-open` | identical | identical |
| `rewind-resend` | identical | identical |
| `rewind-tab` | identical | identical |
| `rewind-up` | identical | identical |
| `undo-open` | identical | identical |
| `undo-resumed` | identical | identical |

### /skills

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `skills` | identical | identical |
| `skills-bare` | identical | identical |
| `skills-cancel` | identical | identical |
| `skills-down` | identical | identical |
| `skills-empty` | identical | identical |
| `skills-enter` | identical | identical |
| `skills-esc` | identical | identical |
| `skills-filter` | identical | identical |
| `skills-none` | identical | identical |
| `skills-open` | identical | identical |
| `skills-send` | identical | identical |
| `skills-typed` | identical | identical |

### @path

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `path` | identical | identical |
| `path-dir` | identical | identical |
| `path-dir-continue` | identical | identical |
| `path-down` | identical | identical |
| `path-e2e-alp` | identical | identical |
| `path-e2e-dir` | identical | identical |
| `path-e2e-word` | identical | identical |
| `path-enter` | identical | identical |
| `path-esc` | identical | identical |
| `path-filter` | identical | identical |
| `path-mid` | identical | identical |
| `path-nomatch-enter` | identical | identical |
| `path-none` | identical | identical |
| `path-scroll` | identical | identical |
| `path-tab` | identical | identical |

### Composer idle

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `idle` | identical | identical |

### Model

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `model` | identical | identical |
| `model-bare-enter` | identical | identical |
| `model-ctrl-o-in-menu` | identical | identical |
| `model-down` | identical | identical |
| `model-esc` | identical | identical |
| `model-failing` | identical | identical |
| `model-fav` | identical | identical |
| `model-fav-then-favtab` | identical | identical |
| `model-favs` | identical | identical |
| `model-favs-all` | identical | identical |
| `model-filter` | identical | identical |
| `model-filter-bs` | identical | identical |
| `model-filter-fuzzy` | identical | identical |
| `model-filter-provider` | identical | identical |
| `model-left` | identical | identical |
| `model-nick-delete` | identical | identical |
| `model-nick-edit` | identical | identical |
| `model-nick-edit-save` | identical | identical |
| `model-nick-esc` | identical | identical |
| `model-nick-esc-esc` | identical | identical |
| `model-nick-fav` | identical | identical |
| `model-nick-invalid` | identical | identical |
| `model-nick-new` | identical | identical |
| `model-nick-replace` | identical | identical |
| `model-nick-replace-ok` | identical | identical |
| `model-nick-save` | identical | identical |
| `model-nick-save-tab` | identical | identical |
| `model-nick-type` | identical | identical |
| `model-nickname` | identical | identical |
| `model-nicks` | identical | identical |
| `model-nicks-all` | identical | identical |
| `model-none` | identical | identical |
| `model-none-all` | identical | identical |
| `model-refresh` | identical | identical |
| `model-right2` | identical | identical |
| `model-select` | identical | identical |
| `model-select-filter` | identical | identical |
| `model-select-oneshot` | identical | identical |
| `model-select-typed` | identical | identical |
| `model-select-unlisted` | identical | identical |
| `model-setting` | identical | identical |
| `model-setting-all` | identical | identical |
| `model-setting-esc` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `model-setting-select` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `model-stab` | identical | identical |
| `model-tab-all` | identical | identical |
| `model-tab-nick` | identical | identical |
| `model-unfav` | identical | identical |
| `model-up-wrap` | identical | identical |

### Settings

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `auto-approve-apply` | identical | identical |
| `auto-approve-bare` | identical | identical |
| `auto-approve-down` | identical | identical |
| `auto-approve-none` | identical | identical |
| `effort-apply` | identical | identical |
| `effort-bare` | identical | identical |
| `effort-ctrl-t` | identical | identical |
| `effort-down` | identical | identical |
| `effort-esc` | identical | identical |
| `effort-filter` | identical | identical |
| `effort-none` | identical | identical |
| `settings` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-apply` | identical | identical |
| `settings-apply-empty` | identical | identical |
| `settings-apply-number` | identical | identical |
| `settings-bare` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-bool` | identical | identical |
| `settings-down` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-duration` | identical | identical |
| `settings-end` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-enum` | identical | identical |
| `settings-enum-down` | identical | identical |
| `settings-esc` | identical | identical |
| `settings-filter` | identical | identical |
| `settings-list` | identical | identical |
| `settings-none` | identical | identical |
| `settings-number` | identical | identical |
| `settings-number-typed` | identical | identical |
| `settings-pgdn` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-reset` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-reset-apply` | identical | identical |
| `settings-reset-down` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-search-all` | identical | identical |
| `settings-second-run` | identical | identical |
| `settings-secret` | identical | identical |
| `settings-stab` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-tab` | identical | identical |
| `settings-tab2` | identical | identical after masking; the truncated scratch path escapes the path mask |
| `settings-tab3` | identical | identical |
| `settings-tab4` | identical | identical |
| `settings-tab5` | identical | identical |
| `settings-tab6` | identical | identical |
| `settings-tab7` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `settings-text` | identical | identical |
| `settings-value` | identical | identical |
| `settings-value-back` | identical | identical |
| `settings-value-none` | identical | identical |

### Slash

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `slash` | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) |
| `slash-down` | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) |
| `slash-enter-goal` | identical | identical |
| `slash-enter-usage` | identical | identical |
| `slash-esc` | identical | identical |
| `slash-filter` | identical | identical |
| `slash-filter-re` | identical | identical |
| `slash-none` | identical | identical |
| `slash-pgdn` | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) | differs: scrollbar thumb one row longer (the dropped commands are absent from the list) |
| `slash-tab` | identical | identical |
| `slash-tab-re` | identical | identical |
| `slash-tab-type` | identical | identical |

### Subagent pool

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `pool` | identical | identical |
| `pool-add` | identical | identical |
| `pool-add-discard` | identical | identical |
| `pool-add-discard-yes` | identical | identical |
| `pool-add-done` | identical | identical |
| `pool-add-esc` | identical | identical |
| `pool-add-model` | identical | identical |
| `pool-add-model-filter` | identical | identical |
| `pool-add-model-pick` | identical | identical |
| `pool-add-model-tab` | identical | identical |
| `pool-add-provider` | identical | identical |
| `pool-add-provider-pick` | identical | identical |
| `pool-down` | identical | identical |
| `pool-esc-empty` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `pool-model-esc` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `pool-save-empty` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `pool-seeded` | identical | identical |
| `pool-seeded-delete` | identical | identical |
| `pool-seeded-delete-no` | identical | identical |
| `pool-seeded-delete-yes` | identical | identical |
| `pool-seeded-edit` | identical | identical |
| `pool-seeded-esc` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |
| `pool-seeded-save` | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) | differs: "Smart reasoning effort" reads `default` instead of `(default)` (first-run artifact, see below) |

### ask_user question

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `question` | identical | identical |
| `question-answer` | identical | identical |
| `question-down` | identical | identical |
| `question-esc` | identical | identical |
| `question-other` | identical | identical |

## ask_user question menu: dropped by scope

`scenarios_question.py` scripts an `ask_user` call under the default Bare profile.
Both CLIs print `Unknown tool: ask_user` and show no question box, which is why those branches are identical.
In term2-next the tool needs the `user-interaction` capability, and only the dropped profiles grant it. Legacy behaves the same way.
So no in-scope profile can reach the question menu, and it was not ported.
This also settles the acceptance case below: the "Decline to answer" and "Stop after resolving" entries can't appear.

## Differences that remain, with reasons

None of these appear in a captured menu branch. They are behaviour around the menus.

- **Settings are session-only in term2-next.** Next's settings service runs with `disableFilePersistence`. A value saved from `/settings` applies for the session but isn't written to `settings.json`, as it is in legacy. This is a deliberate next design choice. The menu shows the same provenance markers, because `getSource` maps a session-only value back to its saved source.
- **Ctrl+O.** Legacy binds Ctrl+O to `/model `. Next uses Ctrl+O for the tool-output viewer, which is wired into the transcript. That conflict is the owner's call, so it was left alone. The hints and `/help` keep legacy's "Ctrl+O model" text.
- **The next-only slash commands** are `/answer /cancel /command-apply /command-status /exit /followup /queue /rollover /steer /tasks`.
  - They are gone from the slash menu and `/help`.
  - Their dispatch was kept, because the e2e drivers and receipt notices type them.
  - Since legacy's slash menu doesn't list them, typing one needs two Enters: the first closes the menu, the second submits. That matches legacy's handling of any unlisted slash text.
- **`/help` mid-turn** opens next's pager. Legacy writes help into the transcript.
- **Resetting temperature** is refused by next's settings layer.
- **`/copy`** counts replies per message in next. Legacy counts per assistant item. The menu looks the same whenever each message has one reply, which is true of every captured branch.
- **A skill picked from `/skills`** drops images pasted into that same composer.
- **The rewind menu** lists no touched files, because next records no per-turn file list.
- **The model menu** doesn't check a typed model against the catalog before applying it. `/model` validates it instead.
- **Out of scope:** transcript banners, spacing, and the rewind receipt rows in the transcript. These aren't menus.

## Acceptance cases

These six supervisor queue files were readable and were checked against the captures above:

| Case | Result |
|---|---|
| `build-tui-menu-visual-parity` | The slash menu, `/settings`, `/profile`, `/resume` and the model picker are legacy's components, and the captures are identical apart from the scope rows. `/resume` with no saved sessions matches legacy (`resume-empty`). The ten next-only commands are gone from the menu and `/help`, but stay dispatchable (see above). `/lite` is back as a Bare toggle. |
| `build-tui-menu-pickers-missing` | `/profile`, `/providers` (list, wizard, edit, review, delete), `/skills` and `/auto-approve` open legacy's pickers, all identical. `/mcp` is dropped by scope. `/effort` and Ctrl+T are identical. |
| `build-tui-model-picker-actions` | Legacy's footer, failed-provider notice and scrollbar (`model-failing`), and the Favorites tab, are identical. Nickname set, edit, clear and replace, and refresh, are identical (`model-nick-*`, `model-refresh`). The Ctrl+O decision is left to the owner (see above). |
| `build-tui-settings-editors` | Rows use legacy's aligned table and value formats. Enum, boolean, number, duration, text, list, secret and model rows open legacy's editors. All seven tabs are identical (`settings-*`), apart from the first-run artifact. |
| `build-tui-question-menu-extra-entries` | Dropped by scope: the question menu is unreachable without the dropped profiles. |
| `build-tui-rewind-picker-parity` | `/undo` prints legacy's notice and opens rewind edit, with legacy's rows and footer. Tab resend works (`undo-open`, `rewind-*`, `rewind-resend`, `rewind-tab`), and every branch is identical. |

### Real-terminal soak items

The supervisor's real-terminal side-by-side check (`rewrite/parity/real-terminal/report/soak-differences.md`, branch `claude/ecstatic-tesla-86lzj4`) was measured on main, before this port. These are its menu items:

| Soak item | Covered by | Result |
|---|---|---|
| 22 `/` menu as a `Filter:` box | `slash`, `slash-down` | identical apart from the scope scrollbar |
| 23 `/` menu contents and order | `slash`, `slash-pgdn` | legacy's list and order. The next-only commands are gone, `/lite` and `/retry` are back. The dropped-feature commands are absent (scope). |
| 24 selected-row style | `slash-down` | identical (styles compared) |
| 25 filtering `/re` | `slash-filter-re` | identical |
| 26 Tab runs the highlighted command | `slash-tab-re`, `slash-tab` | identical |
| 30 `/model` opening tab and empty-tab text | `model`, `model-none`, `model-tab-nick` | identical |
| 31 model picker border, `Filter:` and hints | `model*` | identical |
| 32 model chosen message | `model-select` | identical |
| 33 effort picker | `effort-*` | identical |
| 34–35 `/settings` layout and value display | `settings-*` | identical apart from the first-run artifact |
| 36 Enter toggles a boolean | `settings-bool` | identical |
| 37 settings search | `settings-search-all` | identical |
| 39–41 `/profile`, `/providers`, `/auto-approve` open pickers | `profile-*`, `prov-*`, `auto-approve-*` | identical apart from the scope profile rows |
| 42 `/mcp` | none | dropped by scope |
| 50 `/rewind` flow | `rewind-*`, `rewind-long` | identical |
| 52 `/undo` in a resumed chat | `undo-resumed` | identical |
| 54–55 resume list layout and entries | `resume-*` | identical (ids masked) |
| 56 PgDn in the resume list | `resume-pgdn` | identical, after a fix: next listed 10 entries where legacy lists 9. Legacy counts the session in use toward its 10 and then hides it. |
| 59 `@` menu | `path-*` | identical |

