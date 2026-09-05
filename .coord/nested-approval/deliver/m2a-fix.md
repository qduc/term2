# M2a review-fix report

Implemented in `m2a-nested-owner`.

## Findings

1. **Interceptor/error policy denial cannot become advisory approval.** The direct result builder now clears pending approval state and fails closed before advisory/grant handling for `error` and `interceptor_denied`; the batch coordinator rejects both before forced-human/advisory routing. Unknown policy results are explicitly logged and continue through the existing advisory/manual path without using the registry fast-approve path. Added a positive advisory interceptor fixture asserting the advisory model is not called and no session read grant is installed.
   - Coverage: `conversation-result-builder.test.ts` interceptor-denial fixture; focused direct-consumer suite.
2. **Consent is bound to workspace/path meaning.** `run_code` binds supported file-tool paths at preparation time, records the preparation root and resolved argument meaning, revalidates both after the wait, and dispatches the bound arguments. Nested descriptors use the same authority-aware outside-workspace metadata helper as direct prompts.
   - Coverage: owner authority invalidation; run-code active-root-change test; real session edit-grant reuse and descriptor metadata test.
3. **Nested worktree transitions are prohibited.** Added `enter_worktree` and `exit_worktree` to `RUN_CODE_PROHIBITED_TOOLS`; direct definitions remain unchanged.
   - Coverage: existing parameterized prohibited-tool test now includes both names.
4. **Nested rejection reasons have owned composer state.** `useConversation` now keys nested rejection-reason state to the displayed nested request, routes competing ordinary pending interactions away from it, and clears it on nested request replacement/cancellation.
   - Coverage: real ConversationService scripted approve/abort integration plus the existing App/BottomArea routing coverage; the state is kept outside the provider interruption reducer.
5. **Observer publication no longer opens a grant/dispatch race.** Entry removal is now internal; the final grant/dispatch commit occurs before observer publication. Observer exceptions, including initial subscription callbacks, are contained. A second observer is rejected instead of silently replacing the first.
   - Coverage: observer-throw/commit-order owner test and observer-slot behavior in the owner implementation.
6. **Denied-read/Docker state is approved-only.** `applyApprovalGrant` computes the disposition first and gates all read/Docker/edit state changes on approval.
   - Coverage: direct executor test for a rejected Docker decision with staged denied-read state; no override or project read grant remains.
7. **Nested owner availability is explicit and default-off.** `ConversationService` accepts `enableNestedApproval`, defaults it to false, preserves it through reset, and the interactive CLI is the only production construction that opts in. Gateway/headless construction therefore retains immediate refusal.
   - Coverage: default-off ConversationService construction test and real service-owner integration test.
8. **Nested editor descriptors carry session-grant metadata.** Descriptor construction is shared through `approval-descriptor.ts`; nested editor prompts now include `outsideWorkspaceEdit` based on the prepared root/target.
   - Coverage: run-code real editor-grant test asserts the outside-workspace metadata and later matching auto-approval.
9. **Approved execution failures are distinct from denial.** Added `failed` to `NestedApprovalResolution`; post-authorization grant/dispatch errors are recorded as `error` once and preserve the original error. User denial remains the pre-dispatch `denied` result.
   - Coverage: owner dispatch-failure test and run-code real-owner failure mapping path.
10. **Acceptance coverage was expanded.** Added real service + real owner scripted approve/abort coverage, real run-code denial/no-replay coverage, real session-grant reuse, root/target/graph invalidation cases split independently, and the approved-only grant regression. The two existing BottomArea tests remain behavioral routing tests; they are no longer used as evidence for session ownership.
11. **Low-severity telemetry/subscription items.** `policy_error` and `interceptor_denied` get distinct run-code records/summary text and no longer advise direct calls. Observer registration is exclusive and enforced. The JSON fingerprint remains conservative defense-in-depth; its undefined/non-enumerable/cycle limitations are documented by the owner contract and are not reachable through the JSON sandbox parameter crossing.

## Deliberately not changed

- The `JSON.stringify` fingerprint algorithm was not replaced with a canonical serializer. Script arguments are schema-parsed/JSON-crossed before this seam, and the authority root plus bound target meaning now provide the production protection required by M2a. Replacing it would be a separate contract/API change; it remains conservative where it can deny rather than grant.
- M2b deterministic adapter/evidence and M3 deadline accounting remain out of scope as required by the brief.

## Validation

The nonexistent selector check was performed before editing: `source/hooks/use-conversation.test.tsx` does not exist and was not cited as a test.

### Focused gate

```text
$ tsc --noEmit

Test Files  11 passed (11)
Tests       287 passed (287)
```

### Related gate (verbatim result)

```text
Test Files  1 failed | 86 passed (87)
Tests       1384 passed | 2 expected fail (1387)
Errors      1 error
FAIL source/lib/openai-agent-client.public-methods.test.ts > abort before Codex start preparation prevents model dispatch
TypeError: releaseDiscovery is not a function
Unhandled Rejection: AbortError: Operation aborted
```

This is the specified known failure from the brief; it is outside the changed approval surfaces and was not modified. The related gate is therefore red, not reported as green.

### Provider black-box gate (verbatim summary)

```text
Test Files  19 passed (19)
Tests       176 passed | 1 skipped (177)
Duration    57.44s
```

### Other checks

- `pnpm typecheck` passed.
- Focused approval/session tests passed: 11 files, 287 tests.
- Changed-file ESLint passed with one existing `require-yield` warning in `conversation-service.test.ts:89`; Prettier check passed.

M2A-FIX-DONE
