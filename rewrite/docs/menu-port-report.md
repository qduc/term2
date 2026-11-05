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

**Speed.** A run is mostly waiting for the screen to settle (CLI boot, the quiet period after each step,
`<sleep>`), not CPU, so `compare` runs `JOBS` scenarios at once (default: the CPU count). Captures are cached in
`.cache/menu-compare/`, keyed by the CLI's build output, the lockfile, the Node version, the capture code in
`screen.py` and the scenario's own steps and seed. Legacy is the oracle and rarely rebuilds, so a compare of a
new next build only runs next; rerunning an unchanged build, adding a scenario, or editing the comparison code
reuses every earlier capture. A timing-sensitive scenario (for example `t-walk`) can capture differently from run
to run; the cache freezes one sample, so resample a suspect with `REFRESH=1` (rerun and overwrite) and use
`CACHE=0` when you want the old behaviour. `run` never uses the cache.

The scenarios live in `scenarios_*.py`.
A branch is **identical** when every screen row is equal after masking, both text and cell styles.
The masks cover only:
- the version string;
- session ids (next's ids carry a `conv_` prefix);
- timestamps;
- the scratch path;
- the fake provider's port;
- durations;
- generated subagent run ids (`western-mantis-118`).

Accepted differences that would touch every screen are cut from legacy's captures before comparing
(`ACCEPTED_LEGACY_ONLY` in `screen.py`): the composer hint `│ Shift+Tab plan` and the `/help` prefix
`Shift+Tab: switch Standard/Plan · `, both Plan mode, a dropped profile (#149).

**Checking a fix, not parity.** To see what a change does to next, compare next's own screens before and after
it, not the legacy-vs-next verdicts: a scenario that already differs from legacy keeps saying `differs` when
the fix changes its screen (item 11's `bg-read` did). Capture next for the scenario set on both builds and diff
the captured lines; with the cache, the second build costs only next's runs.

**Lost-line trap (fixed, #145).** At the exit confirmation after `/help`, next lost help's last line. A `RAW=`
trace showed the cause in Ink 7.0.1: its full-clear redraw writes the frame without a trailing newline but
records it as `frame + "\n"`, so the next ordinary redraw erased one row above the frame. Next commits `/help`
while its frame still overflows, so it took that path; legacy's frame kept overflowing and repainted by full
clear, so it never showed. `patches/ink@7.0.1.patch` records what was written, for both CLIs.

**Scenarios on another provider.** A seed's `env` adds environment variables, `$BASE` standing for the fake
provider's URL, and `ready` names the text to wait for at launch. `upstream` makes every reply chunk name an
upstream provider, as OpenRouter's do (`openrouter-upstream`). OpenRouter's base URL must come from
`OPENROUTER_BASE_URL`: it is an env-only setting, and launch rewrites the settings file without it. (Legacy
reads the file before that rewrite and so honours a file value for one launch; next does not.)

**Timing-sensitive branches.** `bg-continue` races the background explorer's completion against the parent's
reply. When the child finishes first, legacy folds the two calls into "Delegated to 1 subagent, ran 1 tool
call" and draws no completion row; both CLIs draw the same transcript when the reply comes first. Under a full
parallel sweep `bg-spec-shell` and `t-markdown` (a `t/s` reading) can also differ; rerun them alone before
treating a change as a regression.

**Known gap: no usage reported.** When a provider streams no usage, next's status bar shows `↑0 ↓0 · Ctx 0k`
where legacy shows no token figures; next's usage type has no "not reported" state. Real OpenRouter and
OpenAI-compatible streams report usage, so scenarios seed it.

## Result

Measured on `solo/menu-port`, the port rebased onto `a78c60502`, with 262 branches.

**At 100x34, 254 of 262 are identical. At 80x24, 249 of 262 are identical.**
None of the 8 and 13 others is a real difference. They fall into two groups:

- **Dropped by scope (7 branches at each size).** These cover the Plan, Pair, Mentor and Orchestrator profile rows, and the slash commands that serve dropped features: MCP, ACP, sandbox, and those profiles.
  - The profile list has fewer rows (`profile`, `profile-open`, `profile-bare`, `profile-retired`).
  - The slash list is shorter, so its scrollbar thumb is one row longer (`slash`, `slash-down`, `slash-pgdn`). At 80x24 the thumb also sits one row lower on the `slash-pgdn` page.
  - Legacy's list is 31 commands and next's is 25. Next's list is legacy's minus exactly `/mentor /orchestrator /plan /sandbox /mcp /mcp-login`, in the same order and with the same descriptions. Next lists no command that legacy lacks. This was checked by paging both menus to the end at 200x40.
- **Masking only (1 branch at 100x34, 6 at 80x24).** The text matches, and only a masked value's width differs:
  - At 80x24, a session id that wraps across two rows escapes the id mask, because next's ids carry `conv_` (`resume-list`, `resume-down`, `resume-filter`, `resume-bare`, `resume-pgdn`). Only the two id rows differ.
  - At 80x24, the truncated scratch path escapes the path mask (`settings-tab2`).
  - At 100x34, `resume-pgdn` lists twelve rows. Each row's age is masked, but `9s` and `10s` truncate the title at different columns. It is identical in two solo reruns.

The first-run settings artifact is fixed, so the 16 settings and subagent-pool branches are identical now.
- After a first run the settings file was already byte-identical on both CLIs, apart from the scratch path and port. Both write the full file at launch. So the write was not the cause.
- The cause was that each next session re-read that file through a fresh `SettingsService`. Legacy's ancillary migration (`agent.mentorReasoningEffort` → `agent.smartReasoningEffort`) then ran on a key the launch never had. Legacy's one service migrates only when it loads the file at launch, so it shows `(default)` until its next launch.
- Now a session keeps the launch service's values for the four migration targets (`keepLoadTimeMigrations`, `direct-application-runtime.ts`). `settings-second-run` stays identical.

Typed commands now resolve as legacy's do (`typed-*`, all identical, notice row included). An exact name in any case, or a unique prefix, runs that command. Several matches give `Ambiguous command /x: …`. No match gives `Unknown command /x. Did you mean …?`. Text such as `/tmp/x` is sent as a message. `/tasks`, `/steer`, `/followup` and `/exit` were next-only aliases (of Ctrl+G, Enter, Alt+Enter and `/quit`) and are gone. A command's notice and `/usage` output now use legacy's system-message colour.

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
| `resume-pgdn` | identical after masking; the masked row age (`9s` vs `10s`) truncates the title at a different column. Identical in two solo reruns | identical after masking; the wrapped session id escapes the id mask (next ids carry `conv_`) |

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
| `model-setting-esc` | identical | identical |
| `model-setting-select` | identical | identical |
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
| `settings` | identical | identical |
| `settings-apply` | identical | identical |
| `settings-apply-empty` | identical | identical |
| `settings-apply-number` | identical | identical |
| `settings-bare` | identical | identical |
| `settings-bool` | identical | identical |
| `settings-down` | identical | identical |
| `settings-duration` | identical | identical |
| `settings-end` | identical | identical |
| `settings-enum` | identical | identical |
| `settings-enum-down` | identical | identical |
| `settings-esc` | identical | identical |
| `settings-filter` | identical | identical |
| `settings-list` | identical | identical |
| `settings-none` | identical | identical |
| `settings-number` | identical | identical |
| `settings-number-typed` | identical | identical |
| `settings-pgdn` | identical | identical |
| `settings-reset` | identical | identical |
| `settings-reset-apply` | identical | identical |
| `settings-reset-down` | identical | identical |
| `settings-search-all` | identical | identical |
| `settings-second-run` | identical | identical |
| `settings-secret` | identical | identical |
| `settings-stab` | identical | identical |
| `settings-tab` | identical | identical |
| `settings-tab2` | identical | identical after masking; the truncated scratch path escapes the path mask |
| `settings-tab3` | identical | identical |
| `settings-tab4` | identical | identical |
| `settings-tab5` | identical | identical |
| `settings-tab6` | identical | identical |
| `settings-tab7` | identical | identical |
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
| `pool-esc-empty` | identical | identical |
| `pool-model-esc` | identical | identical |
| `pool-save-empty` | identical | identical |
| `pool-seeded` | identical | identical |
| `pool-seeded-delete` | identical | identical |
| `pool-seeded-delete-no` | identical | identical |
| `pool-seeded-delete-yes` | identical | identical |
| `pool-seeded-edit` | identical | identical |
| `pool-seeded-esc` | identical | identical |
| `pool-seeded-save` | identical | identical |

### Ctrl+O

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `ctrl-o-bang` | identical | identical |
| `ctrl-o-draft` | identical | identical |
| `ctrl-o-draft-esc` | identical | identical |
| `ctrl-o-idle` | identical | identical |
| `ctrl-o-stream` | identical | identical |
| `ctrl-o-tool` | identical | identical |

### Typed commands

These close the slash menu with a trailing space and compare the notice row above the composer as well (`scenarios_typed.py`).

| Branch (scenario) | 100x34 | 80x24 |
|---|---|---|
| `typed-ambiguous` | identical | identical |
| `typed-ambiguous-c` | identical | identical |
| `typed-case-help` | identical | identical |
| `typed-exit` | identical | identical |
| `typed-followup` | identical | identical |
| `typed-path-message` | identical | identical |
| `typed-prefix-help` | identical | identical |
| `typed-prefix-usage` | identical | identical |
| `typed-steer` | identical | identical |
| `typed-tasks` | identical | identical |
| `typed-unknown` | identical | identical |
| `typed-unknown-suggest` | identical | identical |

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
- **Tool-output expansion is gone.** Legacy's Ctrl+O replaces the draft with `/model ` (`use-app-keyboard-shortcuts.ts:365`), and so does next's now (`ctrl-o-*` scenarios, identical at both sizes). Next's tool-output viewer, which used Ctrl+O, has no key left, because legacy has none to give it. The supervisor chose this (option a). The unreachable viewer code stays for builder-c to delete.
- **"Resumed conversation: <id>"** shows just above the composer divider in next, as the switch's transition notice. Legacy writes it into the transcript two rows higher.
- **Next-only typed commands still dispatched.** These are `/answer /cancel /command-apply /command-status /queue /rollover`.
  - They are not in the slash menu or `/help`.
  - They are kept because e2e tests drive them, and next's interaction, queue and receipt notices tell the user to type them. Legacy answers each with `Unknown command`.
  - Removing them needs legacy's approval, queue and receipt flows ported first.
- **The dropped-profile commands are still typed-dispatchable.** `/plan /mentor /orchestrator /sandbox /mcp` run in next, with next's wording (`Switched to builtin:plan for this session.`), where the accepted list says those features are absent.
- **Notice placement.** Legacy writes a command's reply into the transcript, with two blank rows above the composer divider. Next shows it directly above the divider. The text and colour now match.
- **Profile toggle and quit wording.** `/bare` (and `/lite`) say `builtin:bare is already active.` where legacy says `Bare mode is already active`. `/quit` doesn't print legacy's `Token usage: …` line on exit.
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
| `build-tui-menu-visual-parity` | The slash menu, `/settings`, `/profile`, `/resume` and the model picker are legacy's components, and the captures are identical apart from the scope rows. `/resume` with no saved sessions matches legacy (`resume-empty`). The next-only commands are gone from the menu and `/help`. `/tasks /steer /followup /exit` are gone entirely, and six stay dispatchable (see above). `/lite` is back as a Bare toggle. |
| `build-tui-menu-pickers-missing` | `/profile`, `/providers` (list, wizard, edit, review, delete), `/skills` and `/auto-approve` open legacy's pickers, all identical. `/mcp` is dropped by scope. `/effort` and Ctrl+T are identical. |
| `build-tui-model-picker-actions` | Legacy's footer, failed-provider notice and scrollbar (`model-failing`), and the Favorites tab, are identical. Nickname set, edit, clear and replace, and refresh, are identical (`model-nick-*`, `model-refresh`). Ctrl+O opens the picker as in legacy, replacing the draft (`ctrl-o-*`). |
| `build-tui-settings-editors` | Rows use legacy's aligned table and value formats. Enum, boolean, number, duration, text, list, secret and model rows open legacy's editors. All seven tabs are identical (`settings-*`). |
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
| 34–35 `/settings` layout and value display | `settings-*` | identical |
| 36 Enter toggles a boolean | `settings-bool` | identical |
| 37 settings search | `settings-search-all` | identical |
| 39–41 `/profile`, `/providers`, `/auto-approve` open pickers | `profile-*`, `prov-*`, `auto-approve-*` | identical apart from the scope profile rows |
| 42 `/mcp` | none | dropped by scope |
| 50 `/rewind` flow | `rewind-*`, `rewind-long` | identical |
| 52 `/undo` in a resumed chat | `undo-resumed` | identical |
| 54–55 resume list layout and entries | `resume-*` | identical (ids masked) |
| 56 PgDn in the resume list | `resume-pgdn` | identical, after a fix: next listed 10 entries where legacy lists 9. Legacy counts the session in use toward its 10 and then hides it. |
| 59 `@` menu | `path-*` | identical |
| Ctrl+O, idle or mid-stream (supervisor case) | `ctrl-o-*` | identical. The draft is replaced, as in legacy. |
| Resume: Enter on a listed session (supervisor case a) | `resume-enter` | The replay matches. "Resumed conversation: <id>" now prints, two rows lower than legacy's (see above). There's no blank prompt with a store written by real runs. |
| Resume: filter as you type (supervisor case b) | `resume-filter`, `resume-filter-none` | identical |

