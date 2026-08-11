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

Multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

**Note:** Keep both lists current — move a plan down when it completes, and drop it entirely once its design record stops earning its place.

## Active or deferred

- Exclusive menu input ownership — follow-on plan tracked in
  `docs/plans/exclusive-menu-input.md`; waiting for implementation approval.
- Scheduled live provider canaries — a deferred follow-up requiring CI, secret/billing, and OAuth-storage decisions. No plan doc, and nobody is on it.
- Provider-faithful reasoning round-trip on the chat-completions lane — planned
  in `docs/plans/chat-completions-reasoning-roundtrip.md`, awaiting
  implementation approval; nobody is on it. Read it before changing how
  `OpenAIChatCompletionsModel` or `openai-compatible-middleware.ts` handle
  reasoning: it records why the existing `reasoning` → `reasoning_content`
  rewrite is not defensive, and why reading `reasoning_details` as reasoning
  text would double every token.
- Background work controls — active implementation tracked in
  `docs/plans/background-work-control/MAP.md`. Background inspection, per-item
  stop, user-action notification, and root-shell transfer are implemented;
  foreground-subagent transfer waits on an explicit post-transfer approval and
  continuation decision. The worktree is `.worktrees/background-task-controls`
  on branch `codex/background-task-controls`.
- UI/business layer separation — completed through settings transaction,
  handoff workflow, provider management, and model catalog milestones. See
  `docs/plans/ui-business-layer-separation/MAP.md` for the merged commits and
  ownership boundaries.

## Completed — still read before touching these areas

- `docs/plans/background-shell-monitor/MAP.md` — **all six phases merged**
  (2026-08-10; last merge `78e5a08c`). Read before touching the shell tool's
  background path, `BackgroundShellRegistry`, `BackgroundShellOutputStore`,
  `BackgroundShellWatches`, the `background_shell_output` notification lane,
  or `shell.backgroundTimeout`: it records the overflow-kill result shape, the
  watch-layer pins, and the pre-existing ink-layer / black-box failures.

- `docs/plans/openai-context-compaction.md` — OpenAI context compaction (server-side
  `context_management`). **All steps are fully merged (`baf07fe0`).** Read the plan before
  touching the OpenAI adapter, the run loop, `ConversationStore`/`conversation-turn-items`, or
  settings schema: it records the closed-union/throw-site findings, the
  `provider_opaque` marker contract, and Round 3's live measurements.

- `docs/plans/queue-editing.md` — editing and deleting a prompt submitted while a turn is in
  flight. **Steps 1–4 are fully merged (`a7a0d677`).** Read it before touching `ApplicationRunLoop.steer`, `ConversationAdapter`'s queue path, `QueueController`, `PendingQueueList`, or `InputBox`.

- `docs/plans/mid-turn-injection.md` — steering and background-subagent notifications reaching a turn already in flight. Read it before touching the run loop, `AgentClient`, the turn coordinator, or notification delivery: it defines the vocabulary those areas are described in (**Segment**, **Request Boundary**, **Injection**, **Background Notification**, now in `CONTEXT.md`), and the bug it fixed was invisible for want of those words.

- `docs/plans/chain-settlement.md` — unpaid tool debt after a mid-stream failure must not leave a live `previousResponseId`. Read before changing `ProviderContinuity`, stream finalize debt sync, terminate recovery, `SessionInputPlanner` chaining, or “No tool output found for function call” classification: a text-only continue against an open chain is a server 400.

# Parallel Work Isolation

Several agents share the primary checkout, so concurrent edits pile into one `git status` with no way to tell whose work is whose.

Do each bug fix or feature in its own worktree: `git worktree add .worktrees/<slug> -b <slug>`. Commit inside it, merge back with `git merge --no-ff <slug>` from the primary checkout, then `git worktree remove` and `git branch -d`. Trivial single-file edits can stay in place.

- **`git worktree add` does not move you into the worktree.** Creating one and then editing leaves every edit in the primary checkout, because the file tools resolve against the session's execution root, not the shell's `cd`. The app's own agent uses the `enter_worktree` tool for this; when working through a harness that lacks it, pass the worktree path explicitly on every edit and verify with `git -C .worktrees/<slug> status`.
- Create worktrees under `.worktrees/`, never as a sibling directory like `../term2-<slug>`. The shell sandbox only grants writes to the workspace root and the temp dir (`allowWrite` in `source/utils/shell/sandbox/sandbox-policy.ts`), so a sibling checkout fails to write — sometimes half-created, with `.git/worktrees/<slug>/` metadata but no checkout.
- Run `pnpm install` directly in each worktree. pnpm links from its global content-addressable store, so this does not duplicate disk space. Do not symlink `node_modules` from the primary checkout — that caused broken `pnpm exec` resolution in the past.
- Never `git checkout` another branch in the primary checkout — other agents have HEAD-dependent work in flight.
- Git refuses a merge that would clobber another agent's uncommitted edits. Coordinate; don't stash their files aside.

# Shell Safety For Agents

- Never put a destructive payload in an ad-hoc shell probe: `rm`, `find -exec`, `sed -i`, `git checkout` / `reset --hard`, or a redirection that writes over an existing file. Shell quoting mistakes can turn test fixtures into real commands.
- Ordinary composition is fine. Pipes, `&&`, `2>/dev/null`, and command substitution are how you run tests and read their output — the hazard is the payload, not the syntax.
- When testing command parsing or safety classification, put cases in a test file or another quoted fixture file and run the test harness. Do not pass dangerous command examples through `node -e`, `tsx -e`, `sh -c`, command substitution, or inline shell one-liners. Keep dangerous strings as data, never as shell syntax.
- Before running anything that could modify or delete files outside the intended edit set, stop and use a read-only inspection path or ask for explicit approval.
