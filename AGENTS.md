# What Is This

A terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js. It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

Because this project *is* an agent harness, `source/prompts/` and tool `description` fields are product behavior, not documentation. Treat edits there as behavior changes and test them accordingly.

# Orientation

Application code lives under `source/`. The non-obvious entry points:

- `cli.tsx` assembles the application; `app.tsx` owns the interactive Ink UI; `non-interactive.ts` runs the same conversation system without the UI.
- `agent.ts` defines the agent and registers its tools.
- `source/services/conversation/conversation-service.ts` is the public conversation facade — start there for conversation behavior, then `source/services/session/session-composition.ts` (composition root), then `source/services/session/turn-coordinator.ts`.
- `source/prompts/prompt-constructor.ts` assembles system prompts from a base profile plus conditional fragments; `prompt-profiles.ts` maps models to bases.

Everything else is discoverable by reading the tree. For module-design decisions, ownership boundaries, and the full turn lifecycle, use the `architecture` skill. For test scope and standards, use the `testing` skill.

# Provider Black-Box Suite

Provider, bridge, run-loop, registry, and non-interactive changes must use the
provider black-box suite as part of development. It protects the application-
owned provider boundary and the shipped CLI against streaming, tool-call,
history, reasoning, and error-path regressions.

Run it with:

```bash
pnpm test:provider-black-box
```

This command builds `dist/` first, then runs the dedicated configuration in
`vitest.provider-black-box.config.ts`. It is intentionally separate from
ordinary `pnpm test` because it launches the built CLI in isolated child
processes.

Suite ownership:

- `scripts/provider-black-box/provider-contract.test.ts` obtains models through
  `source/providers/registry.ts`; do not bypass the registry by constructing
  transport classes directly.
- `scripts/provider-black-box/provider-cli.blackbox.ts` exercises the shipped
  `dist/cli.js` with isolated settings, filesystem state, stdout/stderr files,
  deadlines, and cleanup.
- `scripts/provider-black-box/fake-provider-http-server.ts` and
  `provider-wire-fixtures.ts` contain deterministic loopback HTTP/SSE fixtures.
- `scripts/provider-black-box/fake-provider-websocket-server.ts` owns the
  deterministic WebSocket replay fixture and its terminal/error assertions.
- `scripts/provider-black-box/provider-test-harness.ts` owns child-process,
  stateful PTY, isolated-workspace, restart, and temporary-environment lifecycle.
  Keep it asynchronous; synchronous child execution can deadlock the fake server.
- `scripts/provider-black-box/provider-capability-matrix.ts` and
  `provider-session-capability-manifest.ts` own the test-side capability rows,
  typed lifecycle ledgers, and aggregate accounting.
- `scripts/provider-black-box/provider-session-responses.blackbox.ts`,
  `scripts/provider-black-box/provider-session-stateless.blackbox.ts`, and
  `scripts/provider-black-box/provider-session-resilience.blackbox.ts` own the
  stateful provider lifecycle scenarios and their exported ledger declarations.

When adding or changing a provider scenario:

- Assert semantic wire fields, roles, ordering, IDs, native reasoning/options,
  and authoritative completion/error events rather than full JSON snapshots.
- Keep fixtures minimal, deterministic, harmless, and derived from sanitized
  traffic. Never add real credentials, provider endpoints, or executable shell
  payloads.
- Cover both success and failure/incomplete-stream behavior. A provider must
  not turn a missing terminal event into empty success.
- Run the focused suite, fake-Codex E2E, relevant provider unit tests, and
  `pnpm typecheck`; run the full suite before handoff.
- For a regression fix, add or update a red-proof case when practical: apply
  the test-only change to the pre-fix parent and record that it fails before
  relying on green results after the fix.

The design and acceptance details live in
`docs/plans/integration-test-improvement.md`; update the suite and this section
together when its workflow or ownership changes.

# Work In Progress

**Note:** Keep this section up to date. Remove stale entries and update ongoing ones.

Active multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

Currently active:

- No provider-related plan is active. `docs/plans/post-refactor-provider-boundary-audit.md`
  and `docs/plans/provider-bug-sweep.md` are complete. Scheduled live canaries
  remain a separate deferred follow-up requiring CI, secret/billing, and
  OAuth-storage decisions.

# Delegation

For multi-step work with independently divisible parts, act as the coordinator: delegate bounded subtasks to subagents, remain the user's sole point of contact, integrate their results, and provide one verified final answer. Avoid parallel edits that could conflict, and do not delegate trivial tasks.

# Parallel Work Isolation

Several agents share the primary checkout, so concurrent edits pile into one `git status` with no way to tell whose work is whose.

Do each bug fix or feature in its own worktree: `git worktree add .worktrees/<slug> -b <slug>`. Commit inside it, merge back with `git merge --no-ff <slug>` from the primary checkout, then `git worktree remove` and `git branch -d`.

- Create worktrees under `.worktrees/`, never as a sibling directory like `../term2-<slug>`. The shell sandbox only grants writes to the workspace root and the temp dir (`allowWrite` in `source/utils/shell/sandbox/sandbox-policy.ts`), so a sibling checkout fails to write — sometimes half-created, with `.git/worktrees/<slug>/` metadata but no checkout.
- **Worktree dependencies:** run `pnpm install` directly in each worktree. pnpm links packages from its global content-addressable store, so installing in a worktree does not duplicate disk space versus the primary checkout. Do not symlink `node_modules` from the primary checkout — that path caused broken `pnpm exec` resolution in the past.
- Never `git checkout` another branch in the primary checkout — other agents have HEAD-dependent work in flight.
- Git refuses a merge that would clobber another agent's uncommitted edits. Coordinate; don't stash their files aside.
- Trivial single-file edits can stay in place.

# Shell Safety For Agents

- Never run ad-hoc shell probes containing executable payloads such as `rm`, `find -exec`, `sed -i`, redirections, command substitution, backticks, or shell metacharacters. Shell quoting mistakes can turn test fixtures into real commands.
- When testing command parsing or safety classification, put cases in a test file or another quoted fixture file and run the test harness. Do not pass dangerous command examples through `node -e`, `tsx -e`, `sh -c`, command substitution, or inline shell one-liners.
- To inspect classifier behavior interactively, use hardcoded string literals inside a committed or temporary test file and execute only the test runner. Keep dangerous strings as data, never as shell syntax.
- Before running anything that could modify or delete files outside the intended edit set, stop and use a read-only inspection path or ask for explicit approval.

# Log Files

App logs and traffic logs are JSONL and can be large. Log roots by platform:

| | App logs | Provider traffic |
| --- | --- | --- |
| Linux | `~/.local/state/term2-nodejs/logs/` | `~/.local/state/term2-nodejs/logs/provider-traffic/` |
| macOS | `~/Library/Logs/term2-nodejs/logs/` | `~/Library/Logs/term2-nodejs/logs/provider-traffic/` |

Always query with `jq` for the fields you need rather than reading whole files:

```bash
jq '.summary.unknownFrames' <file.jsonl>
jq 'select(.direction == "received") | .summary.payload' <file.jsonl>
```
