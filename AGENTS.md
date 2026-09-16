# What Is This

A terminal-based AI assistant built with React (Ink), an application-owned agent runtime, TypeScript, and Node.js. It lets users chat with an AI agent in real time; the agent can execute shell commands and modify files, with interactive approval prompts for safety.

# Orientation

Application code lives under `source/`. The non-obvious entry points:

- `cli.tsx` assembles the application; `app.tsx` owns the interactive Ink UI; `non-interactive.ts` runs the same conversation system without the UI.
- `agent.ts` defines the agent and registers its tools.
- `source/services/conversation/conversation-service.ts` is the public conversation facade for conversation behavior.
- `source/prompts/prompt-constructor.ts` assembles system prompts from a base profile plus conditional fragments; `prompt-profiles.ts` maps models to bases. Because this project *is* an agent harness, `source/prompts/` and tool `description` fields are product behavior, not documentation — treat edits there as behavior changes.

## How to read the docs in this repo

**Docs are hints; code wins.** Use docs for orientation, rationale, and rejected approaches, then verify the specific claim you will act on. Check absolutes against every relevant implementation; prefer symbol names to drifting line-number citations.

Everything else is discoverable by reading the tree. Skills carry the depth — activate the matching skill before touching these areas.

# Test execution policy

- **Fast feedback:** focused tests during development; `pnpm test:related` after a coherent source change; `pnpm test:changed` plus `pnpm typecheck` for a narrow handoff. Completion/commit alone does not trigger the full suite. Do not claim completion with required gates unrun.
- **Tier boundaries:** `pnpm test` is unit-only; integration, e2e, and provider black-box tests have separate `pnpm test:integration`, `pnpm test:e2e`, and `pnpm test:provider-black-box` commands. The full-suite CI/publish gate means unit **and** integration. Read [slow-test-suite.md](docs/plans/slow-test-suite.md) before changing tier membership.
- **Justify full-suite launches:** before `pnpm test`, name the broad-change trigger and why focused/related/changed tests are insufficient. Triggers include broadly imported behavior, architectural/cross-module contracts, or package/TypeScript/Vitest/build configuration; otherwise use narrow gates.
- **After a non-trivial fix:** ask what allowed the defect class and why tests missed it. See `## After a bug fix` in the `testing` skill.
- **Lane is not full-suite validation:** `pnpm test:lane` runs only `.github/vitest.lane.safe.txt` without isolation. Admit files only after shuffled seeded runs (`pnpm test:lane:seed <seed>`); files that ever failed non-isolated stay excluded. Isolated full-suite tests remain the broad-change/CI/release authority.
- **Keep `NODE_ENV=test`:** test scripts pin it via `cross-env`; set it when invoking Vitest directly. React's production build lacks `act`.
- **Long validations:** use explicit finite `timeout_ms` sized to the job and background completion notifications, not polling. Record elapsed time and terminal result separately from pass/fail. Diagnose timeouts/hangs rather than blindly rerunning; verify partial effects before replaying mutations. A narrowed rerun does not close a full-suite gate.

# Plans and area-specific context

Read the relevant documents before touching these areas, starting with **Resume here** where present. Keep milestone status, measurements, and implementation history in the linked documents, not this index.

- **Gateway:** [Web client gateway](docs/plans/web-client-gateway-completion.md)
- **`run_code` runtime:** [Lifecycle and contracts](docs/plans/run-code-codemode-improvements.md)
- **Nested approval:** [Inline approval](docs/plans/run-code-nested-approval.md)
- **Sandboxed execution:** [Shared code host](docs/plans/sandboxed-code-host.md)
- **Code-tool diagnostics:** [Authoring friction](docs/plans/run-code-authoring-friction.md)
- **TypeScript support:** [Deferred decision and telemetry](docs/plans/run-code-typescript.md)
- **Settings value entry:** [Field editor](docs/plans/settings-field-editor.md)
- **Settings infrastructure:** [Legacy debt](docs/plans/settings-legacy-debt.md)
- **Session queries/persistence:** [SQLite index](docs/plans/session-query-index.md)
- **Session retrieval UX:** [Observed usage](docs/research/session-retrieval-observed-usage.md), [seek/tail cell](docs/research/session-retrieval-seek-cell.md), [paired protocol](docs/research/session-retrieval-paired-protocol.md), and [cursor format](docs/plans/memory-progressive-disclosure.md)
- **Modes:** [Profile architecture](docs/profiles/README.md)
- **Model/effort step-down:** [Benchmark](docs/plans/model-effort-step-down-benchmark.md) and [cache economics](docs/research/model-effort-step-down-cache-economics.md)
- **Audited tests:** [Test suite audit](docs/plans/test-suite-audit.md) and `docs/test-audit/graph.yaml` — read the graph's primary decisions before editing audited files
- **Service contracts:** [Boundary completion](docs/plans/service-boundary-contract-completion.md) and [contracts](docs/contracts/)
- **UI/business ownership:** [Separation map](docs/plans/ui-business-layer-separation/MAP.md)
- **OAuth:** [Provider independence](docs/plans/provider-oauth-independence.md)
- **Live provider canaries:** Deferred pending CI, secret/billing, and OAuth-storage decisions; no plan doc
- **Candidate gates:** [Decision portal](scripts/candidate-gates.ts) — dormant; see its file header before extending
- **Shell deadlines:** [Evidence-backed timeouts](docs/plans/evidence-backed-shell-timeouts.md)
- **Rollover:** [Session handoff](docs/plans/session-rollover-handoff.md)
- **Grok Responses/credits:** [Provider plan](docs/plans/grok-responses-and-credits.md)
- **Run budgets:** [Stall escalation](docs/plans/run-budget-stall-escalation.md) and [review](docs/plans/run-budget-stall-escalation-review.md)
- **Tool dispatch:** [Parallel-safe dispatch](docs/plans/parallel-safe-tool-dispatch.md)
- **Menu input:** [Exclusive ownership](docs/plans/exclusive-menu-input.md)
- **Chat-completions reasoning:** [Roundtrip](docs/plans/chat-completions-reasoning-roundtrip.md)
- **Background work:** [Control map](docs/plans/background-work-control/MAP.md)
- **Compaction:** [Provider-neutral](docs/plans/provider-neutral-context-compaction.md) and [OpenAI](docs/plans/openai-context-compaction.md)
- **Tool effects/output:** [Safety contract](docs/plans/tool-output-and-effect-safety.md)
- **Background shell output:** [Monitor map](docs/plans/background-shell-monitor/MAP.md)
- **Queued/in-flight input:** [Queue editing](docs/plans/queue-editing.md) and [mid-turn injection](docs/plans/mid-turn-injection.md)
- **Provider continuity:** [Chain settlement](docs/plans/chain-settlement.md)

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
