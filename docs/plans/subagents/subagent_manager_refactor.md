# Refactor SubagentManager

## Summary
Replace `SubagentManager` internals with a thin facade, a single composition root, and three explicit execution strategies. Preserve all public APIs and behavior while reusing existing main-session infrastructure only where lifecycle semantics match.

## Implementation Sequence
1. Add facade-level characterization tests against the current implementation. These remain green throughout the refactor and cover results, event ordering, usage, errors, retries, cancellation, tools, approvals, mentor continuity, nested resume, and write safety.
2. Extract the role loader and prompt builder. Add contract tests that initially cannot compile until the collaborator exists, then move frontmatter parsing, settings inheritance, prompt selection, environment context, and tool guidance.
3. Extract `SubagentToolFactory` and `SubagentToolPolicy`. The factory selects capabilities; the policy owns shell classification, auto-approval, workspace boundaries, locks, and successful-write tracking.
4. Extract `MentorRunner`. It exclusively owns the persistent `SubagentSession`, provider continuity, execution, and reset operation.
5. Extract `ExecutionSubagentRunner` for one-shot explorer, worker, and researcher runs. Continue using the existing `createConversationSession({ retryOptions: { allowFreshStartRetries: false } })` path; no shared-session API change is required.
6. Extract `NestedSubagentRunner` for cached `Agent.asTool()` instances, resume-state restoration, parent approval propagation, interruptions, and nested event metadata.
7. Add `createSubagentRuntime()` as the sole wiring location. It owns collaborator instances and the nested role-tool cache, but not mentor session state.
8. Reduce `SubagentManager` to delegation. Move manager tests to collaborator suites only after the facade characterization suite proves each extraction preserved behavior; remove duplicates afterward.

## Ownership And Compatibility
- Preserve `SubagentRequest`, `SubagentResult`, `SubagentDefinition`, `SubagentBridge`, and every public `SubagentManager` method.
- `MentorRunner.reset()` clears only mentor history and provider state.
- Runtime `clearCache()` clears only cached nested role agents/tools. It must not reset mentor history, matching current behavior.
- Share stable primitives: final-text extraction, usage normalization, model settings, provider runner creation, and guarded event emission.
- Keep result assembly local when strategy semantics differ. Do not introduce mode flags or a universal runner.
- Preserve current error messages and failed-versus-cancelled classification where externally observable.
- Preserve operational retry warning logs and structured retry metadata; other debug logging is not a compatibility contract.

## Test Plan
- Use structured deep equality for complete ordered event sequences and normalized usage objects rather than broad snapshots.
- Characterize role-load failures, missing mentor configuration, malformed resume state, provider failures, abort errors, and successful fallback behavior.
- Verify `clearCache()` between mentor calls preserves history, while `resetMentorSession()` removes it.
- Verify concurrent one-shot and nested workers competing for the same file lock reject the second write without waiting.
- Verify cancellation before nested invocation, interruption/resume, malformed restored context, and cancellation while awaiting propagated parent approval.
- Verify parent approvals are merged only into the resumed nested context and cancelled parents cannot continue stale work.
- After each extraction, run the new collaborator suite and the facade characterization suite.
- After wiring changes, run the bridge suite; finally run `npm test`, `npm run build`, Prettier on changed files, then the full tests again.

## Acceptance Criteria
- Public callers require no changes.
- Facade characterization tests remain green after every extraction.
- Results, errors, event sequence and shape, usage, retries, cancellation, approval behavior, mentor history, nested resume behavior, tools, file tracking, boundaries, and locking remain unchanged.
- `SubagentManager` contains only public delegation and no prompt, tool-policy, cache implementation, or execution workflow logic.
