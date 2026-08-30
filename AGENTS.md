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

**Note:** Keep this list current

## Active or deferred

- Model/effort step-down for tool-continuation turns — **paused
  mid-validation, nothing implemented yet.** Production-log analysis found
  90%+ of expensive-tier (`sol`/`terra`) requests are pure tool-continuation
  steps, not fresh reasoning turns. Real benchmark validation (4 tasks,
  deterministic evaluator + Opus blind quality judge, not log inference)
  confirmed cheap-tier (`luna`) parity on 3 of 4 tasks at 7x-140x lower cost,
  but found a real quality gap on a security-sensitive task — the blanket
  version must not ship without a floor above `luna#low` for
  security-sensitive paths. Read `docs/plans/model-effort-step-down-benchmark.md`
  before touching this: it records the exact benchmark directories, a
  provider-id gotcha (`codex` not `openai-codex`), a host-memory-exhaustion
  trap (do not run 3+ heavy `term2` benchmark candidates as parallel
  background tasks), and a `run-judge.sh` aggregator parsing bug (fixed
  2026-08-30; the recovered task-3 scores also corrected the doc's results
  table).
- Test suite audit — foundation merged, milestone still non-destructive:
  build the evidence graph, not cleanup. Do not remove, rewrite, retier, or
  consolidate tests, and do not dispatch explorers, without the approval
  `docs/plans/test-suite-audit.md` describes. The graph and its vocabulary live
  in `docs/test-audit/`; run it with `pnpm test-audit`.
- Service-boundary contract completion (SB-00 / SB-08) — **CLOSED (program
  complete) 2026-08-16; all residual decisions resolved 2026-08-16.** All
  remaining-SB slices A–K landed and are pushed; Contracts 09/10/11/12 landed
  docs-only and SB-00 is closed. The Consolidated Implementation Backlog at the
  end of `docs/plans/service-boundary-contract-completion.md` is fully
  resolved: SB-01/02/05/06/07 landed as repairs or docs; SB-03/SB-04 hardening
  was declined by decision (composite facade and concrete runtime retained; no
  proven defect); President decisions 2026-08-16 settled the three held secret
  items (credential-at-rest plaintext, direct `/settings` credential display,
  single-level log-sanitization depth), retiring the R10.2 and both C7.2 reds
  as green characterizations. No SB-shaped follow-up remains open: the memory
  strict-subset characterization merged with its worktree
  (`memory-capabilities.test.ts:58`). Read the primary plan's header
  before touching any listed area.
- `tools/president-decision-portal/` and `scripts/candidate-gates.ts` — merged
  on 2026-08-16 from worktrees with no plan doc and no recorded caller. Nothing
  invokes either one outside `scripts/candidate-gates.test.ts`. The portal binds a single hard-coded LAN address and
  writes a token and an append-only ledger under `~/.agents/runtime/`; it is
  inert unless run deliberately. Establish provenance before extending either,
  and consider reverting them if they are not wanted.
- Provider OAuth independence (Grok and Codex) — **backlog items 1-3
  implemented 2026-08-20; item 4 (device flow) still open.** See
  `docs/plans/provider-oauth-independence.md`. term2 now keeps its own
  credential store for both providers, imports the `grok`/`codex` CLI
  credentials as a one-way access-token-only grace, and never writes to
  `~/.codex/auth.json`. `term2 --codex-login` runs the same PKCE flow as
  `--grok-login`, shared via `source/providers/oauth-pkce.ts`. Both providers
  store multiple accounts (`providers/oauth-account-store.ts`, surfaced through
  `providers/oauth-accounts.ts`) with a switcher in Provider Management;
  selecting an account applies from the next term2 session, because a running
  session stays pinned to the account it first resolved. Read the plan's
  **Resume here** before touching `providers/grok-auth.ts`,
  `providers/codex-auth.ts`, `providers/oauth-pkce.ts`, `CodexTokenManager`, or
  `utils/ai/provider-credentials.ts`: it records why registering our own OAuth
  client is a dead end for subscription access, why the loopback-port question
  cannot be settled with curl, and why the refresh-token import must not come
  back.
- Scheduled live provider canaries — a deferred follow-up requiring CI, secret/billing, and OAuth-storage decisions. No plan doc, and nobody is on it.
- UI/business layer separation — completed through settings transaction,
  handoff workflow, provider management, and model catalog milestones. See
  `docs/plans/ui-business-layer-separation/MAP.md` for the merged commits and
  ownership boundaries.

## Completed — still read before touching these areas

- **Grok on the Responses API** (`b065bbc9`, `40c4546a`, 2026-08-20) — no plan
  doc; the constraints are recorded here and in those commit messages. Grok runs
  on the Responses API so encrypted reasoning round-trips, which Chat Completions
  could never do (it only returned a summary). Verified live against the proxy:
  streaming SSE, function calling, usage, `prompt_cache_key`, and
  `include: ['reasoning.encrypted_content']` all work; **chaining does not** —
  `previous_response_id` 404s under Zero Data Retention and `store: true` comes
  back downgraded. So Grok's capabilities declare no chaining and no server-side
  compaction, but a prompt cache key. `TERM2_GROK_API=chat` falls back to the old
  lane.

  Three things stopped keying on provider names, and must not go back:
  - The **opaque lane tag** was hard-coded `openai` because both Responses
    providers happened to be OpenAI. Grok is a second vendor on the same wire
    shape and its ciphertext is not interchangeable, so it gets its own lane;
    the adapter takes the lane as a parameter.
  - The **prompt cache key placement** is a capability, not a provider id.
    Placing it by provider id put Grok on a placement no Responses adapter
    reads, and the live wire showed `prompt_cache_key: null`.
  - The **run loop** kept terminal encrypted reasoning only for the `codex` and
    `openai` namespaces, silently dropping Grok's. It now matches the namespaced
    *shape*, so the next Responses lane is not lossy either.

  `x-grok-conv-id` is the documented xAI header for prompt-cache server
  affinity; the undocumented `x-grok-session-id` is still sent alongside it
  until something upstream is confirmed not to key on it.

- **Grok credit usage in the status bar** (2026-08-21) — no plan doc. Grok's
  meter does *not* come from the inference lane: its Responses stream carries no
  quota frame the way Codex pushes `codex.rate_limits`, and the proxy returns no
  rate-limit response headers. Do not go looking for it there again. It is a
  separate REST call, recovered from the `grok` CLI binary and verified live:
  `GET {GROK_BASE_URL}/billing?format=credits`, bearer token alone, returning
  `creditUsagePercent` plus a weekly `currentPeriod` and a per-product split.
  (Omitting `?format=credits` returns monthly billing totals instead.)

  It is a *percentage of a weekly period consumed*, not a requests-remaining
  allowance, so it cannot render in Codex's used/reset window format and has its
  own slot formatter in `StatusBar`. `lastCodexRateLimit` was deliberately not
  renamed into a shared field: the two shapes have nothing in common beyond the
  slot they occupy.

  Cadence is owned by `services/grok/grok-credit-usage-service.ts`. It refreshes
  on the busy → idle edge of a turn, never on a timer, so an idle terminal makes
  no requests. Before changing the 5-minute cooldown, note why it is long: the
  value is an integer percentage over a *week*, so freshness is nearly
  worthless, while the endpoint is undocumented and worth treating gently. The
  service is process-wide on purpose — the cooldown only holds if every caller
  shares one clock, or a subagent fan-out finishing together each fetches. On a
  401 it stops permanently rather than retrying a token that is already known
  dead. `/usage` forces a refresh past the cooldown.

- `docs/plans/run-budget-stall-escalation.md` — **implemented and merged**, with
  all 13 review findings resolved in
  `docs/plans/run-budget-stall-escalation-review.md`. Read both before changing
  `RunBudget`, run-budget grants, stall detection, the `max_turns_exceeded`
  prompt, or `agent.runBudget` settings: extensions are charged in the run loop
  so unattended resumes stay bounded, parent grants are capped while human
  grants are not, stall evidence re-arms for the run but not for its parent, and
  the stream payload is named `evidence` because `event.event` trips the
  stream-boundary guard.

- `docs/plans/parallel-safe-tool-dispatch.md` — **implemented and merged**
  (`b7eada1e`). It dispatches contiguous auto-approved safe tool calls from one
  completed model response in parallel while preserving result order and the
  existing approval and budget owners.

- `docs/plans/exclusive-menu-input.md` — **implemented and merged**
  (`517b74bc`). Read it before changing Ink input ownership, menu composition,
  `InputBox`, or the session-owned menu surface.

- `docs/plans/chat-completions-reasoning-roundtrip.md` — **implemented and
  merged** (`65746671`, `af85266f`, plus review fixes). Read it before changing
  `OpenAIChatCompletionsModel` or `openai-compatible-middleware.ts` reasoning:
  the `reasoning` → `reasoning_content` rewrite is intentional, and reading
  `reasoning_details` as reasoning text would double every token.

- `docs/plans/background-work-control/MAP.md` — **background inspection,
  per-item stop, action notifications, root-shell transfer, and
  foreground-subagent transfer are implemented.** Read it before changing the
  background registries, task-control port, transfer leases, or adopted-child
  approval handling. Remaining liveness presentation work is tracked separately
  in `docs/plans/background-work-control/liveness-ui.md`.
- `docs/plans/background-work-control/unified-subagent-ui.md` — **implemented
  and merged.** Read it before changing `SubagentActivityMessage`,
  `BackgroundTasksPanel`, `BackgroundTaskManager`, or foreground-to-background
  event routing: a transferred transcript card settles as `backgrounded`, and
  unadopted work may appear on the compact strip only with an explicit
  foreground tag.
- `docs/plans/background-work-control/agent-checkin.md` — **implemented and
  merged.** `BackgroundCheckInScheduler`
  (`source/services/session/background-check-in-scheduler.ts`) periodically
  wakes the launching agent (not just the passive liveness UI) about a
  still-running background shell job or subagent, gated by
  `agent.backgroundCheckIn.{enabled,intervalMs,maxCheckInsPerTask}`. It reuses
  the existing settlement-notification pipeline (`recordBackgroundEvent` ->
  `SubagentNotificationStore` -> the idle-hidden-turn / active-turn-injection
  path) rather than a new turn-start primitive. Read it before changing that
  pipeline, `background-check-in-scheduler.ts`, or `agent.backgroundCheckIn`.

- `docs/plans/background-work-control/liveness-ui.md` — **implemented and merged**
  (`13307919`, with the adversarial-review findings fixed in `93b9b536`). The shared
  protocol lives at `source/services/background-task-activity.ts`;
  `services/session/background-task-liveness.ts` is a deprecated re-export. It separates lifecycle phase/reason, locally
  observed facts, and recent/quiet liveness; captures truthful launch-time
  model/context metadata; and gives the panel and manager explicit, live
  physical-width information budgets plus bounded presentation labels without
  changing execution, cancellation, or transfer semantics.

- `docs/plans/provider-neutral-context-compaction.md` — **Milestones 1–6 fully implemented and verified.** Preserves the OpenAI-native opaque lane and adds an opt-in local fallback built around safe request-boundary cutting, ratio plus an optional raw-token automatic threshold, manual `/compact`, sequential cold-prefix summaries with load-bearing facts copied verbatim, a verbatim hot tail, durable replacement checkpoints, and tool-ledger/continuity safety.
  Read "Cold opaque items are droppable (2026-08-16 correction)" before touching
  `LocalContextCompactor`'s opaque handling: the old fail-closed rule was
  reversed because it silently disabled compaction for the rest of a
  conversation. Cold provider-opaque items are dropped with their turn; the
  invariant that is actually enforced is that a cut never orphans a tool result
  in the hot tail. Read "Foreign opaque items are stripped, not refused" before
  touching any wire converter's `provider_opaque` handling: the acceptance rule
  lives once in `providers/provider-opaque-compatibility.ts` and keys on the
  *lane* tag, not the provider id; converters drop foreign items rather than
  throwing, because throwing bricked every conversation that switched providers.

- `docs/plans/tool-output-and-effect-safety.md` — **Milestones 1–2 implemented and
  merged** (`a41186d6`, from branch `tool-output-effect-safety`). Read before touching `read_file` result
  size, `utils/shell/shell-output.ts` / `utils/output/bound-tool-result.ts`,
  `ToolExecutionStatus`, stream-failure settlement in
  `services/retry/recovery-executor.ts`, or tool dispatch marking: tool results
  are byte-bounded with the shell spool note; dispatched-but-unobserved calls
  settle as `unknown` (not failed) so recovery does not invite blind re-dispatch.

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

- **Model-switch chain drop** (2026-08-30, no plan doc) — a held `previousResponseId` was minted by whatever model produced it; production logs showed a server 400 (`Invalid previous_response_id`) every time `agent.model` changed mid-session (e.g. `gpt-5.6-luna` -> `gpt-5.6-sol`), auto-recovered via `chain_recovery` but wasting a round trip each time. `SessionInputPlanner` (`source/services/session/session-input-planner.ts`) now tracks the model each turn actually dispatches to via `recordDispatchModel()` (called from `InitialInputPreparer.prepare()`, not from inside `build()` itself — `build()` must stay pure because `previewInputSurge()` calls it without dispatching) and drops chaining when the configured model no longer matches. Do not fold this tracking into `build()`.

- **WebSocket Responses session persistence & chain settlement:** WebSocket connections in `CodexResponsesTransport` and `OpenAIResponsesWSModelWithPromptCacheKey` are kept per logical agent (`providerHistoryKey`, else conversation `sessionId`) and stay open across that agent's completed turns so the backend retains in-memory `previous_response_id` state without requiring duplicate `generate: false` warmup requests. Opening one agent's socket must not close another's connecting socket. Sockets close only on `close()`, stream failure, or cancellation. When a 400 `Invalid previous_response_id` triggers `chain_recovery`, `breakChaining()` permanently sets `#chainingBroken` on that session's `ProviderContinuity` (`source/services/provider-continuity.ts` `#breakChaining`), so `SessionInputPlanner` builds full history for every later turn. That is true of the *application* layer only. The Codex provider layer holds its own anchor in `#lastLogicalRequestByKey` (`source/providers/codex-responses-model.ts`), and that is what actually writes `previous_response_id` onto the wire. `disableChaining` is one-shot — the run loop clears it after a single attempt — and `#forgetCodexResponseId()` clears the anchor, but `#rememberCodexResponseId()` re-arms it (and resets `#serverHistoryReuseDisabled`) on the next response. So on the Codex lane a chain recovery yields one genuinely full-history request, after which the model re-anchors and trims the app's full history back to a delta. A retry that omits `previous_response_id` must be self-contained full history. `ApplicationRunLoop` and `CodexResponsesWSModel` must not retry a caller-supplied chained delta without that anchor: the run loop only has the delta, and the Codex unchained fallback would send the same one-item input. Session recovery (`retry_fresh` + `full_history` + `disableChainingForAttempt`) is the path that actually has the transcript. (`codexPreviousResponseIds` looks like the anchor but is written and cleared and never read.)

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
