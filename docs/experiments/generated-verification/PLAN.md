# Generated edge-case verification

## Goal and authority

Deliver a permanent, inexpensive, LLM-free-at-runtime edge-case discovery command.
The user authorized end-to-end implementation, evaluation, independent verification,
and integration. LLMs may build/maintain/investigate the tool, never participate in
its execution. The user explicitly clarified that the traditional-unit-test ban
**does not prohibit this generated verification method or persistent tooling**.
This exception is not permission to restore the example-based unit suite.

## Acceptance criteria (frozen before implementation)

1. A documented installed command generates supported inputs/action sequences
   against production code without models, credentials, or AI network calls.
2. Properties cite contracts; explicit case and sequence-size budgets make runs
   finite. Initial evaluation budget: 1,000 cases/property, at most 30 actions/case,
   target <=30 seconds per target on this host after dependencies are installed.
   These are evaluation defaults, not correctness guarantees or runtime guards
   on product execution. Record actual costs and revise explicitly if unsuitable.
3. Failed properties exit nonzero, shrink to a replayable example, retain seed,
   replay path, revision/dirty state, case counts and runtime in structured output.
4. History repair/projection is the first target. A queue-controller action model
   is the proposed second target (confirm contracts/callers before implementing).
   Demonstrate structured properties and generated state-machine sequences.
5. Demonstrate detection of a genuine current or historical supported edge-case
   defect, not merely a deliberately injected fault. Independently validate it.
6. Classify every candidate discovered during bounded evaluation. Fix confirmed
   defects and verify before/after, or obtain explicit human agreement to defer.
   Reject/narrow unsupported properties; do not silently weaken contracts.
7. Measure runtime/cases and observed setup/triage effort; distinguish unknown
   effort from zero. No invented token-cost or speedup comparison.
8. Required static and behavioral checks pass; required independent review and
   fresh-agent real-use verification pass on the final artifact. If unavailable,
   completion remains verification-pending.
9. Integrate commands, docs, policy clarification and retained evidence. Promote
   only if the pilot is useful and inexpensive; an evidence-backed do-not-promote
   decision is a valid endpoint, with experimental additions isolated or removed.

## Scope and design direction

Prefer fast-check for structured generation, shrinking, seeds and state commands;
check compatibility before adopting. Keep tooling separate from runtime code and
Vitest unit-test discovery. No generic verification platform, no whole-repo proof,
no model-driven oracle, no mandatory provider spend. Do not auto-enable expensive
CI until its value is demonstrated. Any product bug fix is a separately reviewed
change with appropriate project checks.

## Execution and evidence

- Worktree: `.worktrees/generated-verification`, branch `feat/generated-verification`.
- Base: `6075a3cf` (primary clean when inspected).
- Dependencies installed with frozen lockfile successfully, Node 24.19.0 / pnpm 11.7.0.
- Loaded methods: agentic-loop, implementation, testing, verification, writing-docs,
  guard-design (test-only budgets excluded), finding-triage, term2.
- Required real-use guide: `/home/qduc/.agents/skills/coordinator/references/real-use-verification.md`.
  The global AGENTS link through `qduc-skills/skills/coordinator` is stale; the
  installed canonical equivalent above was read.
- No checker or source modifications yet. Original Gemini checker is hand-written
  deterministic cases plus limited BFS, not conventional fuzzing or formal proof.
- Old queue finding may already be mitigated by `QueueController.#snapshot`:
  inspect before claiming it. Current remove_queued lacks explicit paused cleanup,
  but snapshots can normalize the state.
- `dropUnpairedFunctionCalls` uses first canonical item only; investigate supported
  multi-tool-call histories through `projectHistoryForProvider` (actual export name
  to confirm) in conversation-state-projector.ts before claiming a defect.

## Next steps

1. Inspect contracts, public callers and existing suites for the two targets.
2. Implement small generated runner and target properties; update policy docs.
3. Run bounded discovery, classify/reproduce findings, fix confirmed scoped bugs.
4. Execute required tiers and CLI failure/replay checks; retain evidence.
5. Independent review plus fresh-agent use, evaluate promotion, integrate cleanly.
