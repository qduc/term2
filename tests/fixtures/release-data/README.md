# Release data snapshots

Each directory here, named for a version (`1.4.0/`), is a snapshot of the files
that release writes to disk:

| Path | What it is | How it was made |
| --- | --- | --- |
| `conversations/conv_<id>.jsonl` | A conversation log: two user turns and one shell tool call | Two runs of the built CLI against a loopback provider; the second resumes the first |
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
directory. Everything runs in throwaway directories against loopback servers.
The product writes two absolute paths of the capturing machine, and the script
rewrites that temporary root to the placeholder `/term2-release-data` before
saving: the workspace in the log's first line, and the default memory directory
in `settings.json`. The test swaps the placeholder for its own temporary
directory, because a conversation resumes only from the directory it recorded.
The script then refuses to finish if any saved file still names the capture
directory, the real home directory, the temp directory or the hostname.
Timestamps (`at`, `addedAt`) and generated ids are kept as recorded.

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

The snapshot has no compaction or rollover fact. Neither was cheap to
produce headlessly against a fake provider: the `session_rollover` tool is not
registered for a headless run (the model's call returns `Unknown tool:
session_rollover`), and no headless route to compaction was found. Add a second
conversation here when one exists. The memory store and
MCP files are outside the Core formats and are not captured.
