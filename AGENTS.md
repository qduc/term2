# What Is This

A terminal-based AI assistant built with React (Ink), an application-owned agent runtime, TypeScript, and Node.js. It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

# Orientation

Application code lives under `source/`. The non-obvious entry points:

- `cli.tsx` assembles the application; `app.tsx` owns the interactive Ink UI; `non-interactive.ts` runs the same conversation system without the UI.
- `agent.ts` defines the agent and registers its tools.
- `source/services/conversation/conversation-service.ts` is the public conversation facade for conversation behavior.
- `source/prompts/prompt-constructor.ts` assembles system prompts from a base profile plus conditional fragments; `prompt-profiles.ts` maps models to bases. Because this project *is* an agent harness, `source/prompts/` and tool `description` fields are product behavior, not documentation — treat edits there as behavior changes.

## How to read the docs in this repo

**Treat every document here as a hint, not as ground truth.** These docs were written by someone who had the code in front of them, so they are rarely invented — but they describe the code as it was at the time, and the code has moved since. Stale is the normal state, not the exception.

Where a doc and the code disagree, the code wins. That does not make the doc worthless: it still tells you which area to look at, what the author was trying to achieve, and which approaches were already tried and rejected — none of which the code records. Use the doc to orient, then confirm the specific claim you are about to act on.

The claims most likely to be wrong are the confident ones. A statement written when only one implementation existed tends to survive as a system-wide rule after a second one arrives, so absolutes — "always", "never", "only", "permanently", "for all subsequent" — deserve a check before you rely on them. Line-number citations (`file.ts:123`) drift silently and are worth the least.

**Last full-repo docs verification: `f1f9199d` (2026-08-29).** That sweep covered this file, `CONTEXT.md`, `README.md`, `ROADMAP.md`, the skills, the contract docs, and plan status headers. Anything added or edited since then has not been checked against the code, and three independent passes each found real errors in the one before — so treat even swept text as a hint.

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
- **`pnpm test:lane` runs a fixed no-isolate manifest, not the whole suite.** It executes only the files in `.github/vitest.lane.safe.txt` with worker isolation disabled (~28 s), so a new test file is invisible to it until admitted: a file joins the manifest only after passing shuffled seeded runs (`pnpm test:lane:seed <seed>`), and any file that has ever failed non-isolated stays excluded. The isolated full suite remains the handoff/CI authority. Leak classes and rules: `docs/plans/slow-test-suite.md`.
- **The `pnpm` test scripts pin `NODE_ENV=test` via `cross-env`; keep it that way.** Under `NODE_ENV=production` vitest loads React's production build, whose `react` entry does not export `act`; `renderInAct` then fails ~26 tests in `MessageList.test.tsx` with `TypeError: act is not a function`. The scripts make the ambient value irrelevant, so a bare `pnpm test` is safe — but set it yourself if you invoke `vitest` directly.

- **Orchestrator Mode is prompt-guided, not tool-enforced.** It intentionally uses the same non-lite prompt prefix and tool-building path as standard mode so toggling a runtime mode does not invalidate provider prompt-cache or chained Responses-Lite assumptions. The active workflow arrives in the next user-turn `<system-notice>`: the parent retains end-to-end outcome ownership and should delegate when useful, but direct tools remain available and the harness does not reject `execution: 'foreground'` in orchestrator mode. See `source/agent.ts` and `source/services/mode-notices.ts`.

# Work In Progress

Multi-session work is tracked in `docs/plans/`. Each such plan opens with a **Resume here** section: read it before touching the areas it covers, because it records decisions already taken and premises already disproven. Re-deriving them wastes a session and tends to reintroduce the framing the plan corrected.

**Note:** Keep this list current.

## Active or deferred

- **[Profile architecture](docs/profiles/README.md)** — **Specification approved; Milestone 1 not implemented.** Read before changing built-in modes, mode settings, mode notices, mode-specific prompt/context/tool construction, Plan enforcement, Mentor/Orchestrator integration, or saved mode identity. Milestone 1 reconstructs current behavior on one typed Profile resolver before custom Profile discovery.
- **[Model/effort step-down for tool-continuation turns](docs/plans/model-effort-step-down-benchmark.md)** — **Paused mid-validation.** Production-log analysis found 90%+ of expensive turns are continuation steps; benchmark showed `luna` parity on 3/4 tasks at 7x–140x lower cost, but `luna#medium` floor needed for security paths. Mid-turn demotion premise under review due to cache invalidation economics; read [docs/research/model-effort-step-down-cache-economics.md](docs/research/model-effort-step-down-cache-economics.md) before designing.
- **[Test suite audit](docs/plans/test-suite-audit.md)** — **Milestones 1-3 complete; cleanup (M4) next.** All 585 test files at the `d36c392a` inventory have validated graph records (`docs/test-audit/graph.yaml`: 605 tests / 694 contracts / 1230 decisions; merged to main `e3d1b8b7`). M4 pool: 37 rewrites, 5 consolidations, 1 retier (cli.e2e), 1 architecture signal. Read the graph primary decisions (reviewer `test-audit-coordinator`) before touching any candidate file; each M4 batch goes in an isolated worktree with before/after test count + full-suite runtime.
- **[Service-boundary contract completion (SB-00 / SB-08)](docs/plans/service-boundary-contract-completion.md)** — **Closed (program complete 2026-08-16).** Slices A–K and Contracts 09–12 landed. See [docs/contracts/](docs/contracts/) and Consolidated Implementation Backlog.
- **[President decision portal & candidate gates](scripts/candidate-gates.ts)** — **Merged 2026-08-16 (dormant).** Binds hard-coded LAN address and writes to `~/.agents/runtime/`; uncalled outside `scripts/candidate-gates.test.ts`. Establish provenance before extending.
- **[Provider OAuth independence (Grok and Codex)](docs/plans/provider-oauth-independence.md)** — **Items 1–3 implemented 2026-08-20; item 4 (device flow) open.** Shared PKCE flow via `source/providers/oauth-pkce.ts`, independent credential store, multi-account switcher.
- **Scheduled live provider canaries** — **Deferred.** Requires CI, secret/billing, and OAuth-storage decisions. No plan doc.
- **[UI/business layer separation](docs/plans/ui-business-layer-separation/MAP.md)** — **Completed.** Settings transactions, handoff workflow, provider management, and model catalog milestones landed.

## Completed — still read before touching these areas

- **[Session-tool retrieval tuning](docs/research/session-retrieval-observed-usage.md)** — Naturalistic study plus paired cells closed 2026-08-31 with no API change. Pattern 1 (worktree scoping) was repaired after a controlled cell (`1176fe82`). Cursor-invention and no-tail-pagination crossed the repeat bar; the seek/tail control cell is designed and not yet run (`docs/research/session-retrieval-seek-cell.md`). See also [docs/research/session-retrieval-paired-protocol.md](docs/research/session-retrieval-paired-protocol.md) and [docs/plans/memory-progressive-disclosure.md](docs/plans/memory-progressive-disclosure.md) for cursor format.
- **[Session rollover & handoff](docs/plans/session-rollover-handoff.md)** (`fa4b371b`) — M1–M3 merged. Turn settlement deferral and background task safety; auto-rollover remains experimental.
- **[Grok on Responses API & credit usage](docs/plans/grok-responses-and-credits.md)** (`b065bbc9`, `40c4546a`) — Encrypted reasoning round-trip, dedicated `grok` lane, ZDR/no chaining constraints; REST credit usage in `source/services/grok/grok-credit-usage-service.ts`.
- **[Run budget stall escalation](docs/plans/run-budget-stall-escalation.md)** — Merged (all 13 review findings resolved in [run-budget-stall-escalation-review.md](docs/plans/run-budget-stall-escalation-review.md)). `RunBudget`, turn extensions charged in run loop, stall evidence handling.
- **[Parallel safe tool dispatch](docs/plans/parallel-safe-tool-dispatch.md)** (`b7eada1e`) — Dispatches contiguous auto-approved safe tool calls in parallel while preserving result order and approval/budget ownership.
- **[Exclusive menu input](docs/plans/exclusive-menu-input.md)** (`517b74bc`) — Ink input ownership, menu composition, `InputBox`, and session-owned menu surface.
- **[Chat completions reasoning roundtrip](docs/plans/chat-completions-reasoning-roundtrip.md)** (`65746671`, `af85266f`) — `reasoning` → `reasoning_content` rewrite in `OpenAIChatCompletionsModel` and `openai-compatible-middleware.ts`.
- **[Background work control](docs/plans/background-work-control/MAP.md)** — Background inspection, per-item stop, action notifications, root-shell transfer, foreground subagent transfer.
  - [Unified subagent UI](docs/plans/background-work-control/unified-subagent-ui.md): Subagent activity cards, panel, foreground/background routing.
  - [Agent check-in scheduler](docs/plans/background-work-control/agent-checkin.md): Background periodic wakeup via notification pipeline.
  - [Liveness UI](docs/plans/background-work-control/liveness-ui.md) (`13307919`, `93b9b536`): Shared protocol at `source/services/background-task-activity.ts`.
- **[Provider-neutral context compaction](docs/plans/provider-neutral-context-compaction.md)** — Milestones 1–6 merged. `LocalContextCompactor`, cold opaque item dropping, foreign opaque item stripping via `source/providers/provider-opaque-compatibility.ts`.
- **[Tool output & effect safety](docs/plans/tool-output-and-effect-safety.md)** (`a41186d6`) — Byte bounds, shell spool notes, dispatched-unobserved calls settled as `unknown` (not failed).
- **[Background shell monitor](docs/plans/background-shell-monitor/MAP.md)** (`78e5a08c`) — Phases 1–6 merged: `BackgroundShellRegistry`, `BackgroundShellOutputStore`, `BackgroundShellWatches`.
- **[OpenAI context compaction](docs/plans/openai-context-compaction.md)** (`baf07fe0`) — Server-side `context_management`, `provider_opaque` marker contract in `ConversationStore`.
- **[Queue editing](docs/plans/queue-editing.md)** (`a7a0d677`) — Editing/deleting pending queued prompts in flight (`ApplicationRunLoop.steer`, `QueueController`).
- **[Mid-turn injection](docs/plans/mid-turn-injection.md)** — Steering and background notifications injected at request boundaries (see `CONTEXT.md`).
- **[Chain settlement & WebSocket persistence](docs/plans/chain-settlement.md)** — Unpaid tool debt resolution, model-switch chain drop in `SessionInputPlanner`, per-agent WebSocket lifetime, application `breakChaining()` vs Codex `#rememberCodexResponseId()`.

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
