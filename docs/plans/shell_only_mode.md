# Search-Via-Shell Mode (Experiment) — Draft Spec

Status: draft. Not implemented.

## Idea

Drop the curated **search** tools (`grep`, `find_files`) and let the agent reach for `rg` / `fd` / `find` via the shell tool instead — the same division Claude Code's own harness uses. Keep the editing tools (`read_file`, `apply_patch`, `search_replace`) because they earn their keep with structured diffs and approval prompts.

## Hypothesis

The curated search wrappers were added because (a) we didn't trust the model to drive raw shell well, and (b) we wanted structured arguments for approval prompts. Modern frontier models can drive `rg`, `find`, `sed`, etc. directly — the search wrappers may now cost more than they save:

- They re-implement flag surfaces, badly (see the recent `searchPathWouldBeIgnored` heuristic and the `find` enumerate-everything bug).
- They constrain the agent to the wrapper's idea of "useful" flags (e.g. no `--no-ignore` until we added one yesterday).
- They diverge across hosts (fd vs find behaviour differences).
- Maintaining them is a steady source of subtle bugs.

Editing is different — a structured `apply_patch` gives us diff previews and atomic write semantics that `sed -i` / heredocs can't match. So this experiment is narrow: **kill the search wrappers, keep everything else**. The reference is Claude Code's own harness, which exposes `Read`/`Edit`/`Write` as dedicated tools but does *not* expose dedicated grep/glob tools — those go through Bash.

## Scope

In: an app setting — `app.searchViaShell` (configurable via `settings.json` or `/settings app.searchViaShell` at runtime) — that skips registering `grep` and `find_files`. **Note: If changed at runtime, a new conversation must be started for the change to take effect.** Everything else (`read_file`, `apply_patch`, `search_replace`, `ask_mentor`, `web_search`, SSH, shell) stays.

Out (for the experiment):
- New tools.
- Changes to approval flow or sandbox beyond minor allowlist tweaks.
- Removing the curated search tools from the codebase. The experiment is purely additive: a setting, a dynamic system-prompt addendum, possibly two extra entries in the safety allowlist.

## Approval ergonomics — mostly already handled

`source/utils/command-safety/constants.ts` already greenlights the relevant read-only commands:

```
ls, pwd, grep, rg, cat, echo, head, tail, sed, find, wc, git
```

So `rg pattern src/`, `find . -name '*.ts'`, `cat foo.ts`, `head -50 bar.ts` all classify as GREEN today. The current shell tool's `needsApproval` already consults this. Two small gaps:

- `fd` isn't on the list. Add it.
- Verify `git` with `SAFE_GIT_COMMANDS` (status/log/diff/show/blame/grep) flows through cleanly — it should, but smoke-test before relying on it.

No deeper refactor of the safety classifier needed for the experiment.

## Dynamic System-Prompt Addendum

When `app.searchViaShell` is enabled, the prompt builder performs a quick availability check on the host system (e.g., via `which rg` / `which fd` or caching binary presence at startup) to dynamically tailor the search guidance. Rather than presenting generic fallback rules, the system prompt directly instructs the agent to use the available tools.

### Scenario A: `rg` and `fd` are available
Append this guidance to the system prompt:

> ### Searching via the shell
>
> You have no dedicated `grep` or `find_files` tool. Use the shell tool with the standard CLI binaries instead.
>
> **For text search**, use `rg` (ripgrep). Examples:
> - `rg "pattern" src/` — basic search, respects `.gitignore` by default.
> - `rg -i "pattern"` — case-insensitive.
> - `rg --no-ignore "pattern"` — when you need to search `node_modules`, build output, or anything in `.gitignore`.
> - `rg -uu "pattern"` — include hidden + gitignored.
> - `rg -g '*.ts' "pattern"` — restrict by glob.
> - `rg -t ts "pattern"` — restrict by language preset.
> - `rg -n "pattern"` — show line numbers (useful for follow-up edits).
> - `rg -l "pattern"` — list files only.
> - `rg -C 3 "pattern"` — 3 lines of context.
>
> **For file search**, use `fd`. Examples:
> - `fd '\.ts$'` — regex over basenames.
> - `fd -e ts` — by extension.
> - `fd -H -I` — include hidden + gitignored (`-uu` style).
> - `fd 'pattern' path/` — scoped to a directory.
>
> **General shell hygiene:**
> - Quote paths that contain spaces.
> - Prefer absolute paths or paths relative to a known root; avoid `cd`.
> - When chaining commands, use `&&` for "stop on first failure", `;` only if you accept failures, never raw newlines.
> - Don't use `cat` / `head` / `tail` / `sed` / `echo` for reading or writing files — use the dedicated `read_file`, `apply_patch`, and `search_replace` tools. The shell is for *search* and *one-shot inspection*, not for editing.
> - For destructive operations (deletes, force-pushes, schema migrations), pause and confirm before running.

### Scenario B: Fallbacks (`grep` and `find` only)
If `rg` is not found, the text search guidance is dynamically substituted with standard `grep` usage:

> **For text search**, use `grep`. Examples:
> - `grep -rn "pattern" src/` — recursive search with line numbers.
> - `grep -ri "pattern" src/` — case-insensitive recursive search.
> - `grep -rl "pattern" src/` — list matching files only.
> - `grep -C 3 "pattern" src/` — show 3 lines of context.

If `fd` is not found, the file search guidance is dynamically substituted with standard `find` usage:

> **For file search**, use `find`. Examples:
> - `find src/ -type f -name '*.ts'` — search a subtree by basename glob.
> - **Always search from a specific path, not `/`.** Scanning the whole filesystem can exhaust resources on large trees.
> - When using `find -regex` with alternation, put the longest alternative first: `'.*\.(tsx|ts)'` works; `'.*\.(ts|tsx)'` silently skips `.tsx`.

*(The **General shell hygiene** guidelines block is always appended regardless of which search binaries are selected.)*

The "don't use `cat`/`sed` for editing" line is the load-bearing one: it preserves the diff-preview UX of `apply_patch` instead of letting the agent fall back to `sed -i`.

## Metrics

After ~20 representative tasks run side-by-side (curated-search vs search-via-shell):
- Task success rate.
- Token usage per task (shell commands tend to dump more output than wrappers' trimmed results — `rg --max-count` and `head` may need to enter the agent's habits).
- Wall-clock time per task.
- Subjective: does the agent flounder more, or less?

## Sketch of the change

- Add `app.searchViaShell` boolean setting in `source/services/settings-schema.ts` (default `false`) and expose it in `RUNTIME_MODIFIABLE_SETTINGS`.
- In `source/agent.ts`, branch on the setting (`settings.app.searchViaShell`): skip registering `grep` and `find_files`. Ensure documentation or UI warns that runtime setting changes require starting a new conversation to take effect.
- Implement a quick availability check utility (`which rg`, `which fd`) to determine host capabilities.
- Add `source/prompts/search-via-shell.ts` to dynamically assemble the search addendum based on tool availability, conditionally concatenated to the active system prompt.
- Add `'fd'` to `ALLOWED_COMMANDS` in `source/utils/command-safety/constants.ts`.

## Decision point

After the comparison runs:
- Shell-search wins → delete `grep` and `find_files` tools, fold the dynamic system prompt addendum into the default system prompt, retire the setting.
- Curated wins → close the experiment, write down *why* (probably token efficiency or specific failure modes), keep the wrappers.
- Mixed → narrow further: e.g. keep `find_files` (limited surface area) but drop `grep` (which is where most of the wrapper bugs have lived).
