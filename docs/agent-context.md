# Agent context reference

Project plans, operational procedures, and safety constraints. Area documents
contain implementation history and measurements; historical decisions may be
revisited when new evidence supports doing so.

# Plans and area-specific context

Read the relevant documents before touching these areas, starting with **Resume here** where present. Keep milestone status, measurements, and implementation history in the linked documents, not this index.

- **Architecture and turn flow:** [Overview](architecture/architecture-overview.md), [conversation core](architecture/conversation-core.md), and [conversation loop](architecture/conversation-loop.md)
- **Reference guides:** [Logging](reference/logging.md), [public hooks](reference/public-hooks.md), [model discovery](reference/agent-model-discovery.md), [Docker sandbox](reference/docker-host-control-sandbox.md), and [workflow evolution](reference/workflow-evolution.md)
- **Agent assembly:** [Bounded feature composition and deferral criteria](plans/agent-runtime/agent-assembly-migration.md)
- **Gateway:** [Web client gateway](plans/web-client/web-client-gateway-completion.md)
- **`run_code` runtime:** [Lifecycle and contracts](plans/tools/run-code/run-code-codemode-improvements.md)
- **Nested approval:** [Inline approval](plans/tools/run-code/run-code-nested-approval.md)
- **Sandboxed execution:** [Shared code host](plans/tools/run-code/sandboxed-code-host.md)
- **Code-tool diagnostics:** [Authoring friction](plans/tools/run-code/run-code-authoring-friction.md)
- **TypeScript support:** [Deferred decision and telemetry](plans/tools/run-code/run-code-typescript.md)
- **Settings value entry:** [Field editor](plans/settings/settings-field-editor.md)
- **Settings infrastructure:** [Legacy debt](plans/settings/settings-legacy-debt.md)
- **Session queries/persistence:** [SQLite index](plans/sessions/session-query-index.md)
- **Session retrieval UX:** [Observed usage](research/session-retrieval-observed-usage.md), [seek/tail cell](research/session-retrieval-seek-cell.md), [paired protocol](research/session-retrieval-paired-protocol.md), and [cursor format](plans/context-and-memory/memory-progressive-disclosure.md)
- **Modes:** [Profile architecture](profiles/README.md)
- **Model/effort step-down:** [Benchmark](plans/providers/model-effort-step-down-benchmark.md) and [cache economics](research/model-effort-step-down-cache-economics.md)
- **Audited tests:** [Test suite audit](plans/engineering/test-suite-audit.md) — historical; most audited files and `docs/test-audit/` were removed with the unit suite (tags `unit-suite-baseline` / `3eb16591`)
- **Service contracts:** [Boundary completion](plans/engineering/service-boundary-contract-completion.md) and [contracts](contracts/)
- **UI/business ownership:** [Separation map](plans/engineering/ui-business-layer-separation/MAP.md)
- **OAuth:** [Provider independence](plans/providers/provider-oauth-independence.md)
- **Live provider canaries:** Deferred pending CI, secret/billing, and OAuth-storage decisions; no plan doc
- **Candidate gates:** [Decision portal](../scripts/candidate-gates.ts) — dormant; see its file header before extending
- **Shell deadlines:** [Evidence-backed timeouts](plans/approvals-and-sandbox/evidence-backed-shell-timeouts.md)
- **Rollover:** [Session handoff](plans/sessions/session-rollover-handoff.md)
- **Grok Responses/credits:** [Provider plan](plans/providers/grok-responses-and-credits.md)
- **Run budgets:** [Stall escalation](plans/agent-runtime/run-budget-stall-escalation.md) and [review (historical)](https://github.com/qduc/term2/blob/1cc5a0a91e164215edbcbb4291ffb0c0c1726cc2/docs/plans/run-budget-stall-escalation-review.md)
- **Completion verification:** [Adaptive independent verification](plans/agent-runtime/adaptive-independent-verification.md)
- **Tool dispatch:** [Parallel-safe dispatch](plans/tools/parallel-safe-tool-dispatch.md)
- **Menu input:** [Exclusive ownership](plans/terminal-ui/exclusive-menu-input.md)
- **Chat-completions reasoning:** [Roundtrip](plans/providers/chat-completions-reasoning-roundtrip.md)
- **Background work:** [Control map](plans/background-work/background-work-control/MAP.md)
- **Compaction:** [Provider-neutral](plans/context-and-memory/provider-neutral-context-compaction.md) and [OpenAI](plans/context-and-memory/openai-context-compaction.md)
- **Tool effects/output:** [Safety contract](plans/tools/tool-output-and-effect-safety.md)
- **Background shell output:** [Monitor map](plans/background-work/background-shell-monitor/MAP.md)
- **Queued/in-flight input:** [Queue editing](plans/terminal-ui/queue-editing.md) and [mid-turn injection](plans/terminal-ui/mid-turn-injection.md)
- **Provider continuity:** [Chain settlement](plans/providers/chain-settlement.md)
- **MCP servers:** [MCP as `run_code` functions](plans/tools/run-code/mcp-code-mode.md)
- **UI themes and skins:** [Palettes, background detection, layout skins](plans/terminal-ui/theme-system.md) — components take colours from `useTheme()` and layout from `useSkin()`; never write a hex literal or named colour in one, and add a skin only inside `source/skins/<name>/`

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
