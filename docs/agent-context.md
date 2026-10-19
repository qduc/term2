# Agent context reference

Project plans, operational procedures, and safety constraints. Area documents
contain implementation history and measurements; historical decisions may be
revisited when new evidence supports doing so.

# Plans and area-specific context

Read the relevant documents before touching these areas, starting with **Resume here** where present. Keep milestone status, measurements, and implementation history in the linked documents, not this index.

- **Gateway:** [Web client gateway](plans/web-client-gateway-completion.md)
- **`run_code` runtime:** [Lifecycle and contracts](plans/run-code-codemode-improvements.md)
- **Nested approval:** [Inline approval](plans/run-code-nested-approval.md)
- **Sandboxed execution:** [Shared code host](plans/sandboxed-code-host.md)
- **Code-tool diagnostics:** [Authoring friction](plans/run-code-authoring-friction.md)
- **TypeScript support:** [Deferred decision and telemetry](plans/run-code-typescript.md)
- **Settings value entry:** [Field editor](plans/settings-field-editor.md)
- **Settings infrastructure:** [Legacy debt](plans/settings-legacy-debt.md)
- **Session queries/persistence:** [SQLite index](plans/session-query-index.md)
- **Session retrieval UX:** [Observed usage](research/session-retrieval-observed-usage.md), [seek/tail cell](research/session-retrieval-seek-cell.md), [paired protocol](research/session-retrieval-paired-protocol.md), and [cursor format](plans/memory-progressive-disclosure.md)
- **Modes:** [Profile architecture](profiles/README.md)
- **Model/effort step-down:** [Benchmark](plans/model-effort-step-down-benchmark.md) and [cache economics](research/model-effort-step-down-cache-economics.md)
- **Audited tests:** [Test suite audit](plans/test-suite-audit.md) and `docs/test-audit/graph.yaml` — historical; most audited files were removed with the unit suite (tag `unit-suite-baseline`)
- **Service contracts:** [Boundary completion](plans/service-boundary-contract-completion.md) and [contracts](contracts/)
- **UI/business ownership:** [Separation map](plans/ui-business-layer-separation/MAP.md)
- **OAuth:** [Provider independence](plans/provider-oauth-independence.md)
- **Live provider canaries:** Deferred pending CI, secret/billing, and OAuth-storage decisions; no plan doc
- **Candidate gates:** [Decision portal](../scripts/candidate-gates.ts) — dormant; see its file header before extending
- **Shell deadlines:** [Evidence-backed timeouts](plans/evidence-backed-shell-timeouts.md)
- **Rollover:** [Session handoff](plans/session-rollover-handoff.md)
- **Grok Responses/credits:** [Provider plan](plans/grok-responses-and-credits.md)
- **Run budgets:** [Stall escalation](plans/run-budget-stall-escalation.md) and [review](plans/run-budget-stall-escalation-review.md)
- **Completion verification:** [Adaptive independent verification](plans/adaptive-independent-verification.md)
- **Tool dispatch:** [Parallel-safe dispatch](plans/parallel-safe-tool-dispatch.md)
- **Menu input:** [Exclusive ownership](plans/exclusive-menu-input.md)
- **Chat-completions reasoning:** [Roundtrip](plans/chat-completions-reasoning-roundtrip.md)
- **Background work:** [Control map](plans/background-work-control/MAP.md)
- **Compaction:** [Provider-neutral](plans/provider-neutral-context-compaction.md) and [OpenAI](plans/openai-context-compaction.md)
- **Tool effects/output:** [Safety contract](plans/tool-output-and-effect-safety.md)
- **Background shell output:** [Monitor map](plans/background-shell-monitor/MAP.md)
- **Queued/in-flight input:** [Queue editing](plans/queue-editing.md) and [mid-turn injection](plans/mid-turn-injection.md)
- **Provider continuity:** [Chain settlement](plans/chain-settlement.md)
- **MCP servers:** [MCP as `run_code` functions](plans/mcp-code-mode.md)
- **UI themes and skins:** [Palettes, background detection, layout skins](plans/theme-system.md) — components take colours from `useTheme()` and layout from `useSkin()`; never write a hex literal or named colour in one, and add a skin only inside `source/skins/<name>/`

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
