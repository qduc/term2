# Blocked-read approval lost its decision owner

## Cause and fix

The sandbox denied-read gate is a **post-execution** pause: the wrapped shell
registers a gate in `PostExecutePendingRegistry` while the same live tool call
waits. It is not an ordinary interrupted stream waiting for
`SessionTurnAdapter.executeContinuation`.

`SessionTurnAdapter.#postExecuteApprovalTerminal` correctly included the
`postExecute` token. `toTerminalEvent` then rebuilt the public approval descriptor
field by field and omitted that token. `collectTerminalResult` therefore returned
an approval without an owner token, and `ConversationAdapter` selected
`continueAfterApproval` instead of settling the registry and observing the live
run through `continueAfterPostExecuteApproval`.

There is no double-resolution race: at the post-execution pause, the adapter's
ordinary `#pendingDecision` was never installed. The initial sandboxed shell
approval can be automatic, so it never calls `#waitForApproval`; if an ordinary
manual approval preceded execution, `executeContinuation` correctly consumed its
wait before the shell ran. The older approval-flow context can still be present,
which allows the facade's ordinary-approval guard to pass. The wrong continuation
then throws `No conversation decision is waiting`, leaving the registry gate
unanswered and the tool unable to settle.

The fix copies the complete public descriptor in both directions, omitting only
the private `rawInterruption` on the event boundary and restoring that field only
through the runtime lookup. No approval policy, grant, sandbox, decision-address
validation, or tool execution behavior is relaxed. A denial releases the gate
with its original blocked-read result; an allow-once decision retries with the
requested grant.

## Reproduction and evidence

The permanent test is `scripts/approval-decision.e2e.test.ts`. It uses a loopback
chat-completions provider, the built CLI, an isolated HOME/workspace, a real Linux
sandbox and real PTY input. Its reduced reproduction reads a private fixture
using shell redirection, producing the same hidden-path read-denial class as the
original experiment's blocked temporary-file redirection. It does not replay all
three original experiment commands or call a paid provider.

- Before the fix: the denied-read prompt appeared; `n` plus a reason produced
  the exact exception, with only one provider request and no tool result.
- After the fix: four cases pass: deny, allow once, Escape, and deny with
  `shell.autoApproveMode=auto`. The blocked-read gate still requires a human
  even in auto mode. Deny sends the blocked result, not private content; allow
  once sends the fixture content. Escape permits a new turn. Every case completes
  an additional user turn, checking that no retained run remains stranded.
- Final focused run: 4/4 pass. Existing shell/run-code integration baseline:
  10/10 pass before and after.
- Full provider black-box tier: 25 files, 221 passed, 1 skipped. This includes
  ordinary approval/denial and automatic continuation paths across providers.
- Fake-Codex network: 16/16 pass. Static guards: 28/28 pass. Typecheck and lint
  pass; lint reports 31 warnings in untouched files. No-unit-test guard passes.
- Full integration tier on the implementer's host: 198 passed, 6 failed, 1 skipped;
  the same six failed with both changed source files reverted. On the independent
  reviewer's host the tier ran 204 passed, 1 skipped, 0 failed both with and
  without the fix, so those six failures are host-specific, not caused by this patch.
- Independent review (Claude Opus): approved with notes. Reverting the two source
  files to main makes deny, allow-once and auto-approve fail with the exact error;
  Escape passes on main too, so it is regression coverage, not a reproduction.

Run the focused reproduction after `pnpm build`:

```sh
pnpm test:e2e scripts/approval-decision.e2e.test.ts
```

The real-sandbox tests explicitly skip on hosts without Linux, working bubblewrap,
or socat. This host lacked socat; a package was downloaded and extracted to
`/tmp/approval-fix-socat`, and the tests ran with
`PATH=/tmp/approval-fix-socat/usr/bin:$PATH`. The downloaded `.deb` was deleted;
no system package or repository dependency was installed.

## Sibling audit and prevention

- Both executable terminal/event conversion sites now derive their public
  descriptors rather than maintaining drifting field lists. Only the
  `toTerminalEvent` change fixes this bug: the collector already passed
  `postExecute` on main, but it dropped `deniedRead`, `dockerHostControl`,
  `outsideWorkspaceEdit` and `workspaceRoot`, which it now keeps.
- A temporary probe verified roundtrip preservation of those fields, workspace
  root and the post-execution token, plus exclusion of the private interruption
  from the public event. The temporary file was removed, not committed.
- `createApprovalRequiredTerminal` constructs descriptors from explicit inputs;
  it already includes the token. The log projection and approval-requested hook
  are passive records, not decision routing, so their narrower payloads remain.
- Ordinary waits still require exact interruption identity and generation;
  post-execution waits still require session/epoch/revision/entry validation.
  Escape aborts the live run and fail-closes its registry entries rather than
  answering an ordinary decision. None of these owners changed.

Retro: preventable, latent since post-execution approval was introduced in
`84b10ce1`; that commit added the token to the terminal constructor and collector
but omitted terminal-to-event conversion. Optional fields made an ownerless
descriptor representable; duplicated projections and implicit coupling allowed
the loss. The incorrect assumption was that every approval terminal implied an
ordinary decision wait. The detection gap was the complete interactive
terminal/event/facade journey, not shell execution itself. Deriving the public
projection and testing the real boundary are the structural prevention; a new
lint rule, settings migration, or larger approval-state redesign is unnecessary
for this repair. The existing exception exposed the failure but not the missing
owner; the PTY regression now detects both lack of provider continuation and
failure to accept a subsequent turn. No broader duration or incident rate is
inferred from the single experiment report.

## Independent verification pending

No independent acceptance is claimed. The selected Zai verifier could not start
successfully (stale worktree registry, generic shell admission restrictions, then
provider `429 Insufficient balance or no resource package`). The coordinator
explicitly instructed the implementer to finish checks and commit, leaving
independent verification pending for a separate Claude review. Do not treat the
implementer's checks above as that independent review.
