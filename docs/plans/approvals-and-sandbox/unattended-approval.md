# Unattended approval: build brief

**Status:** built (2026-11-20). Part A is `src/session/approval/approval-route.ts`, `approval-arbiter.ts` and `unattended-refusals.ts`; part B is `src/tools/workspace/workspace-snapshot.ts` (a shadow repository, decision 7) and `src/session/approval/unattended-snapshot.ts`. Evidence: `tests/cli/unattended-approval.e2e.test.ts` and the `approvals` target of `pnpm verify:generated`. The decisions below are the ones built.

Rationale, evidence and the deferred designs are in [`docs/research/unattended-approval.md`](../../research/unattended-approval.md). This brief states what to build and how to tell it is done. It does not prescribe a design.

## Goal

A fifth `shell.autoApproveMode` value, `unattended`, in which no approval request waits for a person. A request the reviewer approves runs as it does in `auto`. Every other request is refused to the model with a reason, and the model continues. Repeated refusals end the turn. Each unattended turn starts with a workspace snapshot, so a mistake inside the sandbox can be undone.

The security target is the one in the research document: prevent accidents, bound injection damage with the sandbox, do not attempt to resist an agent working against its monitor.

## Decisions

Proposed as defaults on 2026-11-20. The owner changes them here before building; the builder does not reopen them.

1. The mode is a new setting value, not `auto` with no person attached.
2. `ask_user` still asks in an interactive client. Headless keeps its stop marker.
3. The refusal limit is 3 consecutive or 10 total per turn or background task.
4. Where a sandbox is enforcing, an escape from it (`unsandboxed-once`) is refused without a review. A setting, off by default, lets the reviewer decide it as in `auto`. The person chose the sandbox; the agent does not leave it on a reviewer's word.
5. Unattended works without a sandbox (owner decision, 2026-11-20). When no sandbox contains the command (sandbox disabled or unavailable, or an SSH execution context), a shell request goes to the reviewer as it does in `auto`. The reviewer is then the only layer, and the user-facing documentation says so.
6. The snapshot is taken in `unattended` only.
7. The snapshot lives in a shadow git repository under term2's state directory, not in the workspace's repository (owner decision, 2026-11-20, after the first build used a private ref in the project). It keeps the snapshot out of the sandbox's writable paths, writes nothing to the project, and covers a non-git workspace. Criteria B1 and B3 below are worded for it.

## Constraints

- **The threshold does not move.** `acceptVerdict`, `SHELL_AUTO_APPROVAL_INSTRUCTIONS` and its prompt version stay as they are. Unattended changes where a non-approval goes, with decision 4 as the only stricter rule.
- **The other four modes do not change.** Nor do headless without `unattended`, or the worker policy in `SubagentToolPolicy`.
- **One owner.** The route, the refusal and the limit are decided in `src/session/approval/`. Clients render a state; none decides. No new branch on a tool name outside `describeApproval`. The import rules and gates in `docs/architecture/layers.md` hold.
- **Fail closed.** In `unattended`, an error, timeout, abort or ambiguous state refuses. It never allows and never waits.
- **Prompts stay fixed.** The main prompt and tool descriptions are not edited; the refusal result carries the guidance. Decision D5 in `llm-auto-approve-unsandboxed.md` is the precedent.
- **Sandbox floors are untouched**: the protected write paths and credential denials in `sandbox-policy.ts`.
- **Guards follow the `guard-design` skill**: the refusal limit, and the snapshot's retention and cost bounds.
- **Testing policy.** No permanent unit tests. Use integration and e2e tests, and generated properties for the pure route. CLI approval fixtures isolate `TMPDIR`, `TEMP` and `TMP`.
- **This is a permission-boundary change**: an independent verifier is required, per the `verification` skill.
- **Proportion.** No metrics pipeline, refusal ledger, task envelope or evidence split. The research document defers them.
- **TUI rendering** uses `useTheme()` and `useSkin()`.

## Acceptance criteria

### A. The mode

1. `unattended` is selectable wherever the other four values are. The default stays `off`.
2. In `unattended`, no approval prompt reaches any client for a turn-owned, task-owned or nested `run_code` request. `ask_user` follows decision 2.
3. A request whose review passes `acceptVerdict` runs with the same grant and the same durable record as in `auto`.
4. A request whose review does not pass, or is unavailable, returns a refusal as the call's result. The refusal names what was refused, gives the reason (the reviewer's reasoning, or that the review was unavailable) and tells the model to take a different approach. The turn continues.
5. These are refused with no model call: the `explicit-user`, `denied-read` and `docker-host` gates, a tool that is not reviewable, `propose_goal`, and the escape in decision 4. A run check-in is declined; unattended never grants budget or turns.
6. With the setting from decision 4 on, an escape follows criteria 3 and 4.
7. At the refusal limit the turn ends with no further model request. Its final output lists each refusal of the turn with its reason. Headless exits non-zero. A result that is not a refusal resets the consecutive count. The session accepts a new user turn afterwards.
8. Each refusal is a durable fact with policy provenance and the review attached. A reopened session shows it as refused, never as pending. A client cannot record a refusal or an approval as automatic.
9. A mode change while a review runs never yields an answer under the old mode; the request follows the current mode. A request already open for a person when the mode becomes `unattended` stays open.
10. Headless without `--auto-approve` is unchanged. With `--auto-approve` and `unattended`, criteria 3 to 7 apply before the `NonInteractiveApprovalPolicy` fallback.
11. A behaviour matrix (surface × mode × tool × gate → outcome), captured before the change for `off`, `advisory`, `auto` and `always`, is identical after it.
12. With the sandbox disabled or unavailable, or over SSH, a shell request in `unattended` is routed to the reviewer as in `auto`, and criteria 3, 4 and 7 apply to it.

### B. The snapshot

1. Before the first tool call of an unattended turn in a local workspace, a commit holding tracked, staged and untracked non-ignored files is written to a shadow repository outside the workspace (decision 7). In a git workspace, `HEAD`, refs, the index, the working tree, the stash and the object store are unchanged: `git status --porcelain`, `git ls-files -s`, `git for-each-ref` and `git count-objects` print the same before and after.
2. Criterion 1 holds in a primary checkout and in a linked worktree.
3. A non-git workspace is snapshotted the same way, and no `.git` is created in it. Over SSH, or when the snapshot fails or exceeds its cost bound, the turn proceeds and one notice says there is no snapshot. A snapshot never fails or blocks a turn.
4. The end-of-turn output, including the refusal-limit report, names the snapshot and the files changed since it.
5. A documented restore command is exercised by a test: after a turn that modifies, deletes and creates files, it returns the modified and deleted files to their pre-turn content. The documentation says what it does with files the turn created.
6. Old snapshots are pruned by a stated rule.

## Done when

- Every criterion is demonstrated by a committed integration or e2e test, or by recorded evidence where a test cannot reach it.
- `pnpm typecheck`, `pnpm lint`, `pnpm check:no-unit-tests`, `pnpm verify:generated`, `pnpm test:integration` and `pnpm test:e2e` pass on the reported revision.
- The independent verifier's report is in `.handoff/`.
- The user-facing approvals page (`website/src/content/docs/safety/approvals.md`), the README's approvals section and the session module's interface document describe the mode. The approvals page states what unattended does not defend, as the research document lists it, and that without a sandbox the reviewer is the only layer.
- A and B land as separate commits, A first.
