# What Is This

A terminal-based AI assistant built with React (Ink), OpenAI Agents SDK, TypeScript, and Node.js. It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

Because this project *is* an agent harness, `source/prompts/` and tool `description` fields are product behavior, not documentation. Treat edits there as behavior changes and test them accordingly.

# Orientation

Application code lives under `source/`. The non-obvious entry points:

- `cli.tsx` assembles the application; `app.tsx` owns the interactive Ink UI; `non-interactive.ts` runs the same conversation system without the UI.
- `agent.ts` defines the agent and registers its tools.
- `source/services/conversation/conversation-service.ts` is the public conversation facade — start there for conversation behavior, then `session-composition.ts`, then `turn-coordinator.ts`.
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
- `scripts/provider-black-box/provider-test-harness.ts` owns child-process and
  temporary-environment lifecycle. Keep it asynchronous; synchronous child
  execution can deadlock the fake server.

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

- `docs/plans/provider-bug-sweep.md` — sweeping every provider for regressions from the decoupling work above. Seven real bugs found and fixed so far (silent empty output, dropped tool calls, wrong role serialization); two open (codex loses tool-continuation state across turns, reasoning effort no-ops for Anthropic/Google) plus a newly-found, uninvestigated hang in the openai provider. Read it before touching `source/providers/`.

# Delegation

For multi-step work with independently divisible parts, act as the coordinator: delegate bounded subtasks to subagents, remain the user's sole point of contact, integrate their results, and provide one verified final answer. Avoid parallel edits that could conflict, and do not delegate trivial tasks.

# Parallel Work Isolation

Several agents share the primary checkout, so concurrent edits pile into one `git status` with no way to tell whose work is whose.

Do each bug fix or feature in its own worktree: `git worktree add .worktrees/<slug> -b <slug>`. Commit inside it, merge back with `git merge --no-ff <slug>` from the primary checkout, then `git worktree remove` and `git branch -d`.

- Create worktrees under `.worktrees/`, never as a sibling directory like `../term2-<slug>`. The shell sandbox only grants writes to the workspace root and the temp dir (`allowWrite` in `source/utils/shell/sandbox/sandbox-policy.ts`), so a sibling checkout fails to write — sometimes half-created, with `.git/worktrees/<slug>/` metadata but no checkout.
- **Worktree dependencies under the sandbox:** the global pnpm store is readable but not writable, and `~/.npmrc` is credential-denied. A plain fresh `pnpm install` in a worktree can therefore fail or leave an incomplete `node_modules`; do not keep retrying it or request unsandboxed access by default. If the worktree has the same `pnpm-lock.yaml` as the primary checkout, use a relative symlink to the primary `node_modules` (`ln -s ../../node_modules .worktrees/<slug>/node_modules`) and do not run pnpm installation through that symlink. If dependencies differ, use a sandbox-writable store under the temp directory and set `NPM_CONFIG_USERCONFIG=/dev/null`, or stop and report that dependency setup needs an explicit decision. Global pnpm-store write access is intentionally pending; do not assume it.
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
