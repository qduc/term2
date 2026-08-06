# Mid-Turn Injection

## Status

**Status:** Completed. Live mid-turn steer confirmed working by the user on 2026-08-06.


## The defect

Submitting a message mid-turn showed `⏳ Queued` and was not processed until the whole turn finished, despite an injection mechanism existing (`a8b727c1`) that was supposed to deliver it at the next model request.

**Root cause:** injection lifetime was scoped to a *segment*, not a *turn*. A turn is not one run of the loop — it pauses at every approval and resumes through `continueRunStream` as a new segment. Injections offered during one segment were discarded when it ended; offered during the pause between two, they were refused for want of a run. With auto-approval consulted on most shell calls, that window is almost never open.

Evidence: across **3,519 logged provider requests / 92 sessions / 8 days**, no steer was ever admitted.

## Vocabulary (see CONTEXT.md)

The missing words were half the problem — `CONTEXT.md` had no term for a segment, and defined *Steering* as behaviour that did not happen, so readers concluded it worked. Added: **Segment**, **Request Boundary**, **Injection**, **Background Notification**. *Steering* is now a case of *Injection*. Use these terms; they make the bug state itself.

## What landed

| Commit | What |
| --- | --- |
| `499307bf` | Injection lifetime moved from segment to turn; background notifications and shell context routed through the same path |
| `e0cea570` | Merge of the above |
| `b45cf24d` | `AgentClient.continueRunStream` no longer opens each resume with the turn-ending `abort()` |
| (uncommitted) | Fixed delta input slicing (`findChainedDeltaStart` & `filterServerManagedInput`) when user steer messages follow tool results in chained turns, resolving HTTP 400 `No tool output found for function call ...` |

Key mechanics:

- `ApplicationRunLoop` marks the turn paused when a segment ends holding approvals, instead of releasing injections. `steer()` parks during the pause.
- Injections settle only on a real turn end: a segment finishing clean, `abort()`, or a new turn superseding them.
- `abortSegment()` stops what is streaming; `abort()` ends the turn. Resuming uses the former — this distinction is the whole of `b45cf24d`.
- `injectIntoActiveTurn(items)` is the shared entry. `steerActiveTurn` wraps it and adds `STEERING_NOTICE`; system-spoken injections must **not** carry that notice.
- When user steer messages are injected mid-turn after tool results, delta input calculations (`findChainedDeltaStart` and `filterServerManagedInput`) look backwards past trailing user messages for tool results, ensuring function call outputs are preserved alongside injected steer messages in chained requests (`previous_response_id`).

## Premises already disproven

Do not re-derive these.

1. **"The user types during final streaming, so no boundary is left."** Wrong as the general cause. The proven reproductions had plenty of boundaries ahead; the turn continued for a minute afterwards.
2. **"Mid-turn model delivery isn't possible without interrupting the run loop."** False. `#admitPendingSteers` splices into `state.input` at the request boundary. Nothing is cancelled, no running tool is touched.
3. **"It's the `isQueueActive` / `isQueueOwningSubmissions` predicate gap."** Ruled out by the log: `active=true kind=running` in every reproduction.
4. **"An approval interruption is what ends the run."** Partly right, but `run_subagent_async` has `needsApproval: () => false` and one reproduction died anyway — via the external `abort()`, not the approval path.
5. **Unit tests driving `ApplicationRunLoop.continueRunStream` directly prove nothing about resume.** A turn only ever resumes through `AgentClient`. That gap hid `b45cf24d` behind three passing tests. **New tests for this area must go through `AgentClient`.**

## Open items

- **#3 Mode notices — deliberately not fixed.** Toggling Plan Mode mid-turn does not reach the model until the next user turn. The user ruled this out: delivering it mid-turn would confuse the model. Do not "fix" it.
- **Plan Mode enforcement gap (separate concern, unfixed).** `agent.ts:228` feeds `planMode` only into the prompt spec; it does not filter tools. `source/tools/system/shell.ts:397` is the **only** tool checking `app.planMode` live — `create-file.ts`, `apply-patch.ts`, `search-replace.ts` have no check. Toggling Plan Mode mid-turn therefore leaves file writes ungated for the rest of that turn. May be intentional (prompt is the mechanism; shell gets belt-and-braces). Needs a decision, not a silent fix.
- **Rewritten test contract — wants review.** Two tests in `conversation-orchestrator.subagent-notifications.test.ts` asserted the old batching behaviour ("holds a question behind an in-flight parent turn", "drains several completions into a single turn"). They were rewritten to the new contract, not merely repaired. That is a deliberate behaviour change and the piece most worth a second opinion.
- **Diagnostics are still in.** `Steer attempt resolved` (orchestrator), `Steer admitted at request boundary` / `Steer released at run end` (run loop, via optional `logDiagnostic` on `ApplicationRunLoopDeps`, wired at `agent-client.ts`). Keep them until a live steer is confirmed; then decide whether they stay.
- **`stash@{0}`** in the primary checkout is superseded pre-merge instrumentation, safe to drop.

## Pre-existing failures (not from this work)

Verified failing at `de404f0a` with all of this work stashed. Do not chase them:

- `source/hooks/settings-completion-logic.test.ts` — another agent's hooks commit added a `hooks` settings category without updating the test
- `scripts/fake-codex-server.e2e.test.ts`
- `source/components/prompt/ApprovalPrompt.ask-user.test.tsx`
- `tsc --noEmit`: six errors in `source/services/hooks/hook-system.integration.test.ts`

## Checks this work is held to

`pnpm test:provider-black-box` (**mandatory** — this touches the run loop; 152 tests), plus `pnpm exec vitest run source/services source/lib`. Both green at `b45cf24d`.

## Investigation tooling

Provider traffic: `~/Library/Logs/term2-nodejs/logs/provider-traffic/<date>/<session>/`. See the `provider-traffic` and `debugging-logs` skills.

The decisive wire check for a delivered injection is the `STEERING_NOTICE` prefix (`source/prompts/steering-notice.ts`) — sent-body truncation keeps the first 100 chars, so the marker always survives:

```bash
grep -rl "Steering message" ~/Library/Logs/term2-nodejs/logs/provider-traffic
```

Zero hits means no steer has ever been admitted. Note that codex sessions send **delta** input (only new items per request), so an admitted injection appears in the same request as that round's tool results — that is the structural signature. Full-history sessions drop assistant text from replayed history, so they cannot be used to discriminate.
