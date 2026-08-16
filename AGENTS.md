# What Is This

A terminal-based AI assistant built with React (Ink), an application-owned agent runtime, TypeScript, and Node.js. It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

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

# Test execution policy

- **Optimize for fast feedback.** Run focused tests during development; run the relevant broader gate after a coherent change, and reserve the full suite for broad changes or final handoff. Never claim completion while a required gate remains unrun
- **Provider changes run the black-box suite.** Provider, bridge, run-loop, registry, and non-interactive changes must run `pnpm test:provider-black-box` as part of development, not just at the end. See the `provider-testing` skill.
- **A regression test is the floor, not the finish line.** After any non-trivial bug fix, ask what allowed the defect class and why nothing caught it earlier. See `## After a bug fix` in the `testing` skill.
- **Run tests with `NODE_ENV=test`.** If the shell exports `NODE_ENV=production`, vitest loads React's production build, whose `react` entry does not export `act`; `renderInAct` then fails ~26 tests in `MessageList.test.tsx` with `TypeError: act is not a function`. Prepend `NODE_ENV=test` explicitly (e.g. `NODE_ENV=test pnpm test`) instead of relying on the ambient value.

# Work In Progress

Multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

**Note:** Keep this list current

## Active or deferred

- Test suite audit — foundation merged, milestone still non-destructive:
  build the evidence graph, not cleanup. Do not remove, rewrite, retier, or
  consolidate tests, and do not dispatch explorers, without the approval
  `docs/plans/test-suite-audit.md` describes. The graph and its vocabulary live
  in `docs/test-audit/`; run it with `pnpm test-audit`.

# Parallel Work Isolation

Several agents share the primary checkout, so concurrent edits pile into one `git status` with no way to tell whose work is whose.

Do each bug fix or feature in its own worktree: `git worktree add .worktrees/<slug> -b <slug>`. Commit inside it, merge back with `git merge --no-ff <slug>` from the primary checkout, then `git worktree remove` and `git branch -d`. Trivial single-file edits can stay in place.

- Create worktrees under `.worktrees/`, never as a sibling directory like `../term2-<slug>`. The shell sandbox only grants writes to the workspace root and the temp dir (`allowWrite` in `source/utils/shell/sandbox/sandbox-policy.ts`), so a sibling checkout fails to write — sometimes half-created, with `.git/worktrees/<slug>/` metadata but no checkout.
- Run `pnpm install` directly in each worktree. pnpm links from its global content-addressable store, so this does not duplicate disk space. Do not symlink `node_modules` from the primary checkout — that caused broken `pnpm exec` resolution in the past.
- Never `git checkout` another branch in the primary checkout — other agents have HEAD-dependent work in flight.
- Git refuses a merge that would clobber another agent's uncommitted edits. Coordinate; don't stash their files aside.

# Shell Safety For Agents

- Never put a destructive payload in an ad-hoc shell probe: `rm`, `find -exec`, `sed -i`, `git checkout` / `reset --hard`, or a redirection that writes over an existing file. Shell quoting mistakes can turn test fixtures into real commands.
- Ordinary composition is fine. Pipes, `&&`, `2>/dev/null`, and command substitution are how you run tests and read their output — the hazard is the payload, not the syntax.
- When testing command parsing or safety classification, put cases in a test file or another quoted fixture file and run the test harness. Do not pass dangerous command examples through `node -e`, `tsx -e`, `sh -c`, command substitution, or inline shell one-liners. Keep dangerous strings as data, never as shell syntax.
- Before running anything that could modify or delete files outside the intended edit set, stop and use a read-only inspection path or ask for explicit approval.
