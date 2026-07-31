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

# Work In Progress

Active multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

Currently active:

- `docs/plans/decouple-from-openai-agents-sdk.md` — removing `@openai/agents*`. Touches the approval layer, the run loop, and `source/providers/`. Progress is measured by the plan's risk register (private-API reach-ins retired), not by lines deleted.

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
