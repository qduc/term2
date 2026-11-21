# Release data snapshots

Each directory here, named for a version (`1.4.0/`), is a snapshot of the files
that release writes to disk:

| Path | What it is | How it was made |
| --- | --- | --- |
| `conversations/conv_<id>.jsonl` | A conversation log: two user turns and one shell tool call | Two runs of the built CLI against a loopback provider; the second resumes the first |
| `conversations-compacted/conv_<id>.jsonl` | A conversation log with a completed automatic compaction, then one more turn: `history_replaced` (reason `compaction`) and `compaction_completed` facts | Three runs of the built CLI against a loopback chat-completions provider that reports input usage past `agent.contextCompaction.compactThresholdTokens`, so the engine summarises on its own; each run resumes the previous. Kept apart from `conversations/` so each directory holds one conversation of one kind |
| `settings/settings.json` | `settings.json` with a few non-default, non-secret values | The product's own `SettingsService.setPersistentDynamic` |
| `config/codex-auth.json`, `config/grok-auth.json` | Provider credential stores with obviously fake tokens | The product's own `saveCodexTokens` and `saveGrokTokens` |

The promise these protect is in `docs/reference/support-tiers.md`, "Persisted
formats": a file written by an earlier release still loads, or is migrated,
after an upgrade. `tests/cli/release-data.integration.test.ts` loads every
snapshot found here with the current build. It copies the files into temporary
directories and never opens these for writing.

## Capture a snapshot

```bash
pnpm build
pnpm capture:release-data          # version from package.json, or: pnpm capture:release-data 1.5.0
```

The script (`scripts/capture-release-data.ts`) refuses to overwrite an existing
directory, and the full capture writes both conversations. Everything runs in throwaway directories against loopback servers.
The product writes two absolute paths of the capturing machine, and the script
rewrites that temporary root to the placeholder `/term2-release-data` before
saving: the workspace in the log's first line, and the default memory directory
in `settings.json`. The test swaps the placeholder for its own temporary
directory, because a conversation resumes only from the directory it recorded.
The script then refuses to finish if any saved file still names the capture
directory, the real home directory, the temp directory or the hostname.
Timestamps (`at`, `addedAt`) and generated ids are kept as recorded.

### Add the compacted conversation to a snapshot that already exists

`1.4.0/` was captured before the compacted conversation existed, and a committed
snapshot is never edited, so that conversation was added by the 1.4.0 release
itself: a clean worktree of tag `v1.4.0` (commit `f14058c7b`), built, and its CLI
named with `--cli`.

```bash
git worktree add .worktrees/v140 v1.4.0 && (cd .worktrees/v140 && pnpm install --frozen-lockfile && pnpm build)
pnpm capture:release-data 1.4.0 --cli .worktrees/v140/dist/src/app/cli.js --only compacted-conversation
git worktree remove .worktrees/v140
```

`--only compacted-conversation` only adds `conversations-compacted/`; it refuses to
run if that directory exists and it never opens another file of the snapshot for
writing. It also refuses to save a log if the CLI did not compact (exactly one
summarising request and a `compaction_completed` fact are required), and applies
the same machine-identity scan. `--cli` changes only which CLI runs the
conversations; the settings and credential writers always come from the current
`dist/`, which is why the option is not used for a full capture of an older version.

## Never edit a committed snapshot

A snapshot is evidence of what that release wrote. If a later release changes a
format and the test fails on an old snapshot, the product must read or migrate
the old file. Do not rewrite the fixture to make the test pass; that hides the
break from the user who still has the old file.

Fixtures carry only synthetic data. Do not capture from a real home directory or
a real provider, and do not put a real key or token in any file here.

## When to add one

At each release that changes a persisted format, at minimum: a log fact or the
log version, a settings key or its meaning, or the credential file layout. Adding
one at every release is cheaper than deciding whether the release qualifies. Add a
directory; do not change the test.

## Not covered

The snapshot has no rollover fact (`session_rollover` / `session_rotated`). The
`session_rollover` tool is not registered for a headless run (the model's call returns
`Unknown tool: session_rollover`), so a rotated session can only be produced through the
TUI, driven through a PTY as `scripts/provider-black-box/automatic-rollover.blackbox.ts`
does. That needs the PTY harness, a TUI that renders in the capture environment, and
capturing two logs (predecessor and successor) with their link; it is not part of the
capture script yet. Compaction is covered by `conversations-compacted/`, by automatic
compaction only: a manual `/compact` log and a native (provider-side) compaction log are
not captured. The memory store and MCP files are outside the Core formats and are not captured.
