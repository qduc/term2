# M2a implementation

## Owner and injection

NestedApprovalOwner lives in source/services/approval/nested-approval-owner.ts.
Its host-side surface is:

- request(request): registers a request and returns the promise for that exact
  nested call;
- getSnapshot() and subscribe(): expose only the one displayed request;
- decide(requestId, { answer, rejectionReason }): accepts only the displayed,
  still-pending identity; and
- close(): settles every remaining waiter as denied.

Each request carries the session ID, complete tool-graph identity, outer run ID,
nested call ID, prepared arguments, authority context, immutable UI descriptor,
and abort signal. Prepared arguments are fingerprinted when queued, and the
snapshot projection is cloned where the value is cloneable. A second pending
call remains in the owner but is not answerable until it becomes displayed.

The interactive ConversationService composes one owner per runtime and
re-attaches it across session reset. AgentClient.setNestedApprovalOwner() passes
it to AgentConfiguration, which binds it to the already-wrapped run_code
definition. The binder records the complete wrapped graph before the factory
filters the model-facing surface, so rebuilds cannot accidentally use a
filtered or stale identity. createSessionRuntime defaults the injection off;
the interactive facade opts in and non-interactive construction explicitly
retains the direct fail-closed fallback.

useConversation subscribes to the owner, and App projects its descriptor
through the existing approval arbitration. Root/background/sandbox prompts
remain higher priority than a queued nested request. When nested approval is
the effective prompt, the UI presents ApprovalPrompt while the real script
continues to await its capability promise. Approve, deny/reason, and Escape
route to the owner; rejection reason text is consumed by the nested request and
is never submitted as an ordinary turn. Programmatic steering remains owned by
the existing turn boundary queue.

## Grant and revalidation semantics

approval-grant-executor.ts is the deliberate shared seam. It owns the existing
answer vocabulary and applies read-folder, edit-file/folder, denied-read, and
Docker grants. ApprovalDecisionExecutor.resolve() now calls that seam rather
than carrying a second implementation. A nested request supplies a grant
callback and a dispatch callback; the owner calls them only after revalidation,
so the owner supplies consent and the grant seam remains the sole authority
boundary. A one-time y authorizes only the current call; session-scope answers
apply the same existing session grant and can make a later policy evaluation
auto-approved.

Before granting/dispatching, the owner checks closure, request identity, session
signal, graph identity, prepared-argument fingerprint, and the policy result.
Only auto_approve or a still-valid exact-call prompt is accepted. Unknown,
error, and interceptor-denied results do not dispatch. Once the final checks
pass, the owner marks the entry executing and removes it from the pending map
before invoking grant/dispatch. This is the approve-wins ordering: cancellation
before that point denies without a grant, while cancellation after dispatch has
started cannot rewrite an already-authorized execution as a cancellation.

ToolApprovalPolicyRegistry.evaluate() now returns error for policy/normalizer
exceptions and interceptor_denied for a registered interceptor denial instead
of conflating either with a valid consent prompt. decide() continues to allow
only explicit auto_approve, preserving direct out-of-band fail-closed behavior.
The direct batch path keeps its existing interactive continuation contract,
while nested run_code refuses errors, unknown policies, and interceptor
denials without presenting a prompt. The native apply_patch replacement
re-registers its interceptor check as well.

No continueAfterApproval, dummy continuation, or approval_required terminal is
used for nested calls. The script worker promise resolves directly, and the
existing direct terminal-result loop is unchanged. Shell and bash remain
prohibited in the run_code namespace.

## Tests added or changed

- source/services/approval/nested-approval-owner.test.ts: exact once-only
  approval, two-request display arbitration, deny with reason, policy-error
  fail-closed behavior, disposal/late answer handling, cancellation-wins, and
  approve-wins race ordering. These tests assert grant and dispatch counts.
- source/tools/system/run-code/run-code.test.ts: real SandboxedCodeHostImpl
  scripts wait on the owner, resume the same worker after approval, catch a
  denial without replaying the earlier effect, and accept a still-prompt
  decision when revalidation becomes auto approval.
- source/services/approval/tool-approval-policy-registry.test.ts: policy
  exception and interceptor-denial result distinctions.
- source/components/layout/BottomArea.test.tsx: Ink approval input routes to
  the approval callback rather than reopening the composer.

Existing approval executor, session composition, conversation facade, hook,
App, and provider lifecycle tests were rerun to characterize direct behavior
and the new wiring. M2b's scripted responder adapter and evidence run were not
implemented: the brief explicitly assigns that work to the separate M2b task.

## Gate output

The required commands were run in the implementation worktree.

~~~~text
pnpm typecheck
$ tsc --noEmit
exit 0

pnpm test source/services/approval/nested-approval-owner.test.ts source/services/approval/tool-approval-policy-registry.test.ts source/services/approval/approval-decision-executor.test.ts source/services/approval/tool-approval-batch-coordinator.test.ts source/tools/system/run-code/run-code.test.ts source/components/layout/BottomArea.test.tsx source/hooks/use-conversation.test.tsx source/services/conversation/conversation-service.test.ts source/services/session/session-composition.test.ts source/app.test.tsx
Test Files  9 passed (9)
Tests       225 passed (225)
exit 0

pnpm test:provider-black-box
Test Files  19 passed (19)
Tests       176 passed | 1 skipped (177)
exit 0
~~~~

pnpm test:related was run for every changed source path in one related-test
selection. It exited non-zero with 134 files selected, 2362 passing, 6
failing, 2 expected failures, and 1 skipped. The failures were the existing
outside-workspace file-policy tests; no changed nested-owner focused test
failed. The known Codex abort-preparation failure (releaseDiscovery is not a
function) appeared in the separate full-suite attempt. The provider black-box
suite failed once on its documented intermittent
reports-provider-errors-without-fabricating-successful-output PTY timeout
and passed on the mandatory retry.

The full pnpm test handoff run was also attempted. It timed out at 120 seconds
after reporting the same existing outside-workspace file-policy failures and
the known Codex abort-preparation failure; it was not represented as a pass.

M2A-DONE
