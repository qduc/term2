# term2 Roadmap

This roadmap outlines the core engineering initiatives, architectural foundations, and forward-looking horizons for **term2**—an open-source, provider-neutral terminal AI assistant and autonomous agent runtime.

---

## Strategic Vision & Architectural Pillars

1. **Open Source & Provider Independence**: Complete freedom across AI providers (OpenAI, Anthropic, Google Gemini, Grok, OpenRouter, and local models via Ollama/llama.cpp) with zero vendor lock-in or mandatory subscription gates.
2. **Contract-Governed Runtime Safety**: Reliable, predictable execution underpinned by observable seam contracts, fail-closed sandboxing, and evidence-backed recovery policies.
3. **High-Velocity Multi-Agent Delegation**: Hierarchical agent swarms with isolated scopes, explicit resource budgets, and real-time steering capabilities.
4. **Local-First Durability & Continuity**: Resilient append-only event streaming, seamless context compaction, time-travel rewind, and offline-safe session management.

---

## Active & In-Progress Initiatives

### 1. Model & Effort Step-Down for Tool Continuation
- **Objective**: Drastically reduce token costs and turn latency by stepping down model reasoning effort on pure tool-continuation turns while maintaining high-tier reasoning for complex architecture and security-critical tasks.
- **Current Status**: Paused mid-validation. Empirical benchmarks demonstrated parity on general coding tasks at 7x–140x lower cost, but highlighted the need for strict floor mechanisms (e.g. `luna#medium`) on security-sensitive paths. Research is actively investigating turn-boundary vs mid-turn demotion due to prompt-cache invalidation economics.
- **Reference**: [`docs/plans/model-effort-step-down-benchmark.md`](./docs/plans/model-effort-step-down-benchmark.md), [`docs/research/model-effort-step-down-cache-economics.md`](./docs/research/model-effort-step-down-cache-economics.md).

### 2. Device Flow Authorization for Headless & Remote Environments
- **Objective**: Implement OAuth 2.0 Device Authorization Grant (`device_code`) for xAI Grok and OpenAI Codex.
- **Current Status**: Open backlog (Item 4 of Provider OAuth Independence). Enables seamless browserless login over remote SSH sessions (`term2 --ssh`) and eliminates local port-binding collisions on headless hosts.
- **Reference**: [`docs/plans/provider-oauth-independence.md`](./docs/plans/provider-oauth-independence.md).

### 3. Test Suite Stewardship & Quality Graph
- **Objective**: Maintain a verifiable, non-destructive evidence graph linking tests to public behavior contracts and operational invariants.
- **Current Status**: Auditing foundation and graph tools merged (`pnpm test-audit`). Active governance over deterministic fast-lane tests (`pnpm test:lane`) and provider black-box wire suites (`pnpm test:provider-black-box`).
- **Reference**: [`docs/plans/test-suite-audit.md`](./docs/plans/test-suite-audit.md), [`docs/test-audit/README.md`](./docs/test-audit/README.md).

---

## Delivered Foundations

The following core milestones have been fully implemented, verified, and merged:

| Milestone | Key Deliverables & Invariants | Reference |
| :--- | :--- | :--- |
| **Background Work Supervision & Liveness** | Full lifecycle control: per-item stop, transfer leases, unified cards, shared liveness protocol (`background-task-activity.ts`), interactive Task Manager (`Ctrl+G`), and periodic check-in scheduler (`BackgroundCheckInScheduler`). | [`docs/plans/background-work-control/MAP.md`](./docs/plans/background-work-control/MAP.md) |
| **Provider OAuth Independence** | Shared PKCE flow (`oauth-pkce.ts`), dedicated credential store, access-token-only CLI import, and multi-account switcher in `/providers`. | [`docs/plans/provider-oauth-independence.md`](./docs/plans/provider-oauth-independence.md) |
| **Service Seam Contracts** | 12 formal boundary contracts governing turn lifecycles, provider continuity, child identity, settings resolution, and runtime guards. | [`docs/contracts/`](./docs/contracts/README.md) |
| **Context Compaction** | Provider-neutral request-boundary compaction (`/compact`) and OpenAI server-side `context_management`, preserving architectural facts and hot-tail tool integrity. | [`docs/plans/provider-neutral-context-compaction.md`](./docs/plans/provider-neutral-context-compaction.md) |
| **Operating Modes** | Standard, Plan (read-only), Lite (no-codebase ingestion), Mentor (dual-model advisory), and Orchestrator modes. | [`source/agent.ts`](./source/agent.ts) |
| **Subagent Swarms** | 4-tier configurable subagent roles (`explorer`, `worker`, `mentor`, `librarian`) mapped to smart, balanced, cheap, and chore model tiers. | [`README.md`](./README.md) |
| **Sandboxing & Auto-Approval** | Read/write sandboxing policies (`standard`, `strict`) paired with hybrid heuristic & LLM auto-approval for safe, fatigue-free terminal workflows. | [`source/utils/shell/sandbox/`](./source/utils/shell/sandbox/) |
| **Time-Travel & Queue Editing** | Interactive rewind/undo/retry with discard preview (`/rewind`), session persistence/forking (`--resume`, `--fork`), and mid-turn prompt queuing (`Alt+Enter`). | [`docs/plans/queue-editing.md`](./docs/plans/queue-editing.md) |
| **Remote SSH Workspaces** | Native remote command execution and codebase modification over SSH agent channels. | [`source/services/ssh/`](./source/services/ssh/) |
| **Grok Responses Integration** | Full Responses API support with encrypted reasoning round-tripping and status bar credit usage tracking. | [`docs/plans/grok-responses-and-credits.md`](./docs/plans/grok-responses-and-credits.md) |

---

## Future Horizons

- **Headless Workflows & Automation**: Scriptable, multi-agent workflows executing end-to-end tasks in automated pipelines without requiring interactive TTY sessions.
- **Scheduled Live Provider Canaries**: Isolated, automated health probes running against real provider endpoints to detect upstream wire format drift, rate limit changes, and latency regressions.
- **Distributed & Remote Subagents**: Delegating background subagent workloads to dedicated remote workers or cloud compute nodes over secure multiplexed streams.
- **Fine-Grained AST Tools**: Enhanced code intelligence tools for AST-aware structural search, refactoring, and auto-healing diff applications.

---

## Engineering & Governance Workflow

All development in this repository adheres to contract-driven, test-backed standards:

- **Isolated Worktrees**: All non-trivial fixes and features are developed in isolated worktrees (`git worktree add .worktrees/<slug> -b <slug>`).
- **Contract-First TDD**: Invariants are proven with failing (red) boundary tests before making production modifications.
- **Verification Gates**:
  - `pnpm test:lane`: Fast deterministic unit test gate (~28s).
  - `pnpm test:provider-black-box`: Required for any provider, bridge, run-loop, or registry changes.
  - `pnpm typecheck` & `pnpm lint`: Zero-tolerance static typing and lint standards.
  - `pnpm test-audit`: Contract and test graph validation.
