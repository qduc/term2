# What Is This

A terminal-based AI assistant built with React (Ink), an application-owned agent runtime, TypeScript, and Node.js. (The `@openai/agents` SDK was removed; `services/agent-runtime/application-run-loop.ts` is our own run loop.) It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

# Orientation

Application code lives under `source/`. The non-obvious entry points:

- `cli.tsx` assembles the application; `app.tsx` owns the interactive Ink UI; `non-interactive.ts` runs the same conversation system without the UI.
- `agent.ts` defines the agent and registers its tools.
- `source/services/conversation/conversation-service.ts` is the public conversation facade for conversation behavior.
- `source/prompts/prompt-constructor.ts` assembles system prompts from a base profile plus conditional fragments; `prompt-profiles.ts` maps models to bases. Because this project *is* an agent harness, `source/prompts/` and tool `description` fields are product behavior, not documentation — treat edits there as behavior changes.

Everything else is discoverable by reading the tree. Skills carry the depth:

| Skill | Use for |
| --- | --- |
| `architecture` | Module-design decisions, ownership boundaries, the full turn lifecycle |
| `testing` | Test scope, standards, and the follow-up expected after a bug fix |
| `provider-testing` | Any provider, bridge, run-loop, registry, or non-interactive change |
| `debugging-logs` | App and provider-traffic log locations and queries |

# Non-Negotiables

- **Provider changes run the black-box suite.** Provider, bridge, run-loop, registry, and non-interactive changes must run `pnpm test:provider-black-box` as part of development, not just at the end. See the `provider-testing` skill.
- **A regression test is the floor, not the finish line.** After any non-trivial bug fix, ask what allowed the defect class and why nothing caught it earlier. See `## After a bug fix` in the `testing` skill.
- **Never claim a test, build, or check passed unless you ran it and it succeeded.**

# Work In Progress

Active multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

**Note:** Keep this section current — remove stale entries and update ongoing ones.

- No plan is currently active. Scheduled live provider canaries remain a deferred follow-up requiring CI, secret/billing, and OAuth-storage decisions.

# Parallel Work Isolation

Several agents share the primary checkout, so concurrent edits pile into one `git status` with no way to tell whose work is whose.

Do each bug fix or feature in its own worktree: `git worktree add .worktrees/<slug> -b <slug>`. Commit inside it, merge back with `git merge --no-ff <slug>` from the primary checkout, then `git worktree remove` and `git branch -d`. Trivial single-file edits can stay in place.

- Create worktrees under `.worktrees/`, never as a sibling directory like `../term2-<slug>`. The shell sandbox only grants writes to the workspace root and the temp dir (`allowWrite` in `source/utils/shell/sandbox/sandbox-policy.ts`), so a sibling checkout fails to write — sometimes half-created, with `.git/worktrees/<slug>/` metadata but no checkout.
- Run `pnpm install` directly in each worktree. pnpm links from its global content-addressable store, so this does not duplicate disk space. Do not symlink `node_modules` from the primary checkout — that caused broken `pnpm exec` resolution in the past.
- Never `git checkout` another branch in the primary checkout — other agents have HEAD-dependent work in flight.
- Git refuses a merge that would clobber another agent's uncommitted edits. Coordinate; don't stash their files aside.

# Shell Safety For Agents

- Never run ad-hoc shell probes containing executable payloads such as `rm`, `find -exec`, `sed -i`, redirections, command substitution, backticks, or shell metacharacters. Shell quoting mistakes can turn test fixtures into real commands.
- When testing command parsing or safety classification, put cases in a test file or another quoted fixture file and run the test harness. Do not pass dangerous command examples through `node -e`, `tsx -e`, `sh -c`, command substitution, or inline shell one-liners. Keep dangerous strings as data, never as shell syntax.
- Before running anything that could modify or delete files outside the intended edit set, stop and use a read-only inspection path or ask for explicit approval.
