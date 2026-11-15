# Approval arbiter: one owner for approval decisions

**Status:** Phases 1–3 implemented on branch `approval-arbiter` (not yet merged; see the PR). Phase 4 (fatigue features) not started. Written against `main` @ `521062bb9` (2026-11-15) and revised the same day after an independent review (see [Review disposition](#review-disposition)).

**As built, where it differs from the design below:**

- **Descriptor.** `describeApproval` in `src/session/approval/approval-route.ts` derives the profile (hard gate, reviewable, one-time `autoGrant`) from the open `InteractionRequest` (its `kind`, `presentation`, offered `grants`, Docker check), not from a per-tool `ToolApproval` returned by each tool. The question "does a call need approval at all" (`approvalFor` and `nestedGrants` in `src/app/source-tools.ts`) is unchanged and still branches per tool.
- **No new fact types.** A review is recorded as an optional `review` on `interaction_opened` / `task_interaction_opened`; an approved review commits the policy close with it. A request under review is not durable at all and reaches clients only as the live `approval_review` transient, so session status, ACP and the notifier change only when a person is asked; no `reviewing_approval` status was needed.
- **Snapshot.** A client attaching mid-review sees `reviewingApprovals` in the snapshot. The recorded `review` rides on live `interaction_opened` events and stays in a client's reduced `pendingInteractions`, but a snapshot rebuilt from session state (attach, reopen) carries the request without it.
- **Stale generation.** An approved review stands only if the session's current generation would still review the request (`ApprovalReviews` asks the current generation's `mayApprove` at settle, true only in `auto`), so a rebuild that switched the mode mid-review to `advisory`, `off` or `always` records no automatic approval.
- **Provenance.** `answer` rejects `automaticApproval: true` from every caller; a client may still send `source: 'policy'` (headless does).
- **Metrics** (fatigue item 7) are not recorded beyond the review on the open fact.


## Problem

Three questions decide what happens to a tool call that might need consent:

1. Does it need approval at all, and which grants does the prompt offer?
2. Once a request is pending, does the LLM reviewer look at it, and does a passing review answer it?
3. With which grant, and is a human needed now?

Each is answered in several places, mostly by `toolName` string checks:

| Place | What it decides today |
|---|---|
| `approvalFor` — `src/app/source-tools.ts:147-225` | Q1: policy registry, `always` bypass (`shouldBypassToolApproval`, which never opens a request), shell escape (`risk: 'high'`, `unsandboxed-once`), Docker deny, folder/Docker grant lists |
| `nestedGrants`, `approvalAnswer` — `src/app/source-tools.ts:228-243`; `src/session/approval/nested-approval-owner.ts` | Q1/Q3 for `run_code` children: grant lists and answer strings |
| `confirmSandboxedShell` — `src/app/tool-surface.ts:216-219` | Q1 for ACP v1: mutating sandboxed shell asks, mode captured when the surface is built |
| `isAutoApprovableTool` — `src/session/approval/shell-auto-approval-resolver.ts` | Q2: which tools the reviewer looks at |
| `createAssistedApprovalReview`, `reviewLiveApproval` — `src/app/lib/approval-model.ts` | Q2: skip rules; a second allowlist of what a pass may approve; a `low`-only threshold for ACP v1 Assisted (`shellEscapeApproval`) and `low`/`medium` for the TUI (`tuiUnsandboxedReview`); turn/task/mode/generation staleness |
| `decideInteraction` — `src/app/tool-surface.ts:325-371`; `NonInteractiveApprovalPolicy` | Q2/Q3 headless: an advisor pass, then a second evaluator with its own `toolName` branches |
| `Host` — `src/clients/tui/approval-host.tsx` | Q2/Q3: runs the review from a React effect, chooses `allow` vs `network-allow-once`, race bookkeeping, `GRANTS`/`approveDecision` |
| `ApprovalPrompt` — `src/clients/tui/approval-prompt.tsx` | Q3: hard-coded option lists per tool family |
| `openPermission` — `src/clients/acp/attachment.ts` | Q2: own eligibility (skips network and `unsandboxed-once` requests) |

The seven fixes on 2026-11-15 (`3726fff51`, `38c5746dc`, `a640bcb28`, `6d38b36a4`, `414580998`, `521062bb9`, and the sandbox prompt change in `9d552d754`) each edited one of these to agree with another. Disagreements still present on `521062bb9`:

- Threshold: ACP v1 Assisted auto-approves only `low` and never reviews `risk: 'high'` or unsandboxed requests; the TUI accepts `low`/`medium` (`shouldAutoApprove`). ACP v2 has no reviewer.
- `isAutoApprovableTool` admits `create_file`, `search_replace`, `apply_patch`, `grep`, `glob`, but the TUI's pass allowlist does not, so a passing review of those still prompts (same shape as the `read_file` bug fixed in `a640bcb28`; not reproduced live).
- `ShellAutoApprovalResolver.recordManualDecision` has no caller, and a resolver is built per request, so the reviewer's "prior human decisions" evidence is always empty.

Two smaller bug classes have the same cause — one fact derived in several places:

- **Path identity.** `resolveSessionReadFolder`, `SessionAccessState.allowReadFolder/allowsRead`, `isInsideDiscoveredSkillRoot` and `resolveOutsideWorkspaceEdit` each expand `~`, resolve relative paths and follow symlinks differently (the last one rewrites `~user/x` as `$HOME` + `user/x`).
- **"Needs a human" signal.** Three derivations: the TUI notification (patched in `414580998`, TUI only), session status `awaiting_interaction` on any `interaction_opened` (`src/session/state.ts:348-357`), which ACP maps to `requires_action` and the control client reads, and each client's own `interaction_opened` handling.

The layer rules already say where this belongs: clients *render the protocol*, and `session/` owns *permissions* (`docs/architecture/layers.md`).

## Goals

1. One module answers Q1–Q3 for every client and owner (turn, task, nested `run_code`).
2. A tool describes its own approval once; nothing else branches on its name.
3. One canonical form for paths and hosts, used for prompting, granting and matching.
4. The reviewer resolves as many requests as it safely can and makes the remaining prompts worth reading, so approving stays a decision rather than a reflex.

Non-goals: changing the reviewer prompt's safety bar, porting Codex guardian machinery (see `llm-auto-approve-evaluator-upgrade.md`, "Out of scope"), auto-*denying* on the reviewer's word.

## Owner decisions already taken

- **One threshold everywhere.** A passing review auto-approves when today's `shouldAutoApprove` holds: mode `auto`, verdict approved, risk `low` or `medium`, authorization `explicit` or `implied`, confidence `high`. This loosens ACP v1 Assisted (from `low`-only, with `high`-risk and unsandboxed requests excluded) to match the TUI. Per-surface postures are not kept.
- **Every reviewable tool is auto-resolvable.** Outside-workspace edits (`create_file`, `search_replace`, `apply_patch`) and searches are auto-approved on a passing review, like `read_file` today.
- **The deterministic `risk: 'high'` on unsandboxed shell is an input to the reviewer, not a routing gate.** It travels as `boundary: 'host'`.
- ACP's session default stays `shell.autoApproveMode = off` (`approvalAlwaysAsks`); that is a mode setting, not a threshold.

## Design

### Overview

```
tools/   ToolApproval  ──►  session/approval/arbiter  ──►  facts  ──►  protocol projection  ──►  clients render
         (requirement,       routeApproval() (pure)                     (state, review, grants)   (TUI / ACP / headless)
          subjects, grants)  reviewer port (app wires model)
```

The arbiter owns a request from the tool's approval requirement to its answer:

```
tool call ──requirement──► none ──────────────────────────────► runs        (policy allow, `always` bypass)
              │
              └──► pending ──route──► reviewing ──pass──► auto_resolved     (answer = autoGrant, provenance policy)
                       │                  │
                       │                  ├──fail / unavailable / stale──► awaiting_user (review attached)
                       │                  └──take_over / user answer──────► awaiting_user / resolved
                       └──route──► awaiting_user                            (hard gate, mode off/advisory-only, not reviewable)
```

Clients only render a state. None starts a review, picks an auto-answer, or decides that a human is needed.

### 1. Tool approval descriptor (tools layer)

Each approval-capable tool returns one descriptor from the place its `needsApproval` lives today. It replaces `approvalFor`'s per-tool branches, `nestedGrants`, and the client option lists:

```ts
type ApprovalSubject =
  | { kind: 'path'; canonical: string; access: 'read' | 'write' }
  | { kind: 'host'; host: string; port: number }
  | { kind: 'command'; text: string; boundary: 'sandbox' | 'host' };

type ToolApproval = {
  /** Q1: `none` runs without a request; `deny` refuses; `ask` opens one. */
  requirement: 'none' | 'ask' | { deny: string };
  subjects: readonly ApprovalSubject[];
  /** Forces a human regardless of mode, except where `always` bypasses today. */
  hardGate?: 'explicit-user' | 'denied-read' | 'docker-host' | 'classifier-red';
  reviewable: boolean;
  /** Grant ids the prompt offers, in order. Clients own the labels. */
  grants: readonly WireGrant[];
  /** The grant a passing review answers with. */
  autoGrant: WireGrant;
};
```

- The name avoids the existing `approval-descriptor.ts` (outside-workspace edit metadata, absorbed into this) and sits alongside `tool-approval-policy-registry.ts`, which keeps registering per-tool `needsApproval`.
- Nested `run_code` children use the same descriptor; their answer strings (`y`, `allow-once`, `docker-allow-once`) are derived from `autoGrant`/grant in one function.
- `isAutoApprovableTool`, `isExplicitShellRequest`, `resolveOutsideWorkspaceEdit`, `unsandboxedOnly`, `tuiUnsandboxedReview` and `confirmSandboxedShell`'s mode capture are replaced by descriptor fields and the route.
- Standing-grant matching stays in one place: the tool's `needsApproval` (via `SessionAccessState` and the project stores). `routeApproval` does not re-check grants.

### 2. Canonical subjects (tools layer, one helper)

`canonicalPath(raw, executionContext)`: expand `~` and `~/` only (leave `~user` literal), resolve against the call's prepared root, then — for local workspaces only — `realpath` the longest existing prefix and re-append the missing tail. Remote (SSH) workspaces stay lexical, matching `src/tools/file/read-access.ts:78-82`. Descriptors, `SessionAccessState` (read folders and edit file/folder grants), read pre-approval and discovered-skill checks all call it. Hosts are lower-cased and port-normalised once (the existing `isSandboxNetworkHost/Port` validation becomes the canonicaliser).

### 3. The arbiter (session layer)

`src/session/approval/approval-arbiter.ts` runs when the session commits a pending interaction (turn-, task- or nested-owned):

1. `routeApproval(input) → 'review' | 'ask_user'` — a **pure** function of `shell.autoApproveMode`, `hardGate` and `reviewable`. This is the only decision table for open requests.
2. On `review`, call the injected `ApprovalReviewer` port (app wires `ShellAutoApprovalResolver` and the approval model client, inside `runtime.scope` and the call's workspace). The reviewer receives prior human decisions for the session, read from facts — this wires the evidence `recordManualDecision` was meant to provide.
3. `acceptVerdict(advisory, mode)` is today's `shouldAutoApprove`, used by every surface. At commit time the arbiter re-reads the mode, the runtime generation and the owning turn/task, and treats any change as stale (carried over from `reviewLiveApproval`).
4. Commit `interaction_review_started` and `interaction_reviewed { advisory }`, then either answer through `Turn.answer` with `autoGrant` and `{ source: 'policy', automaticApproval: true }`, or move to `awaiting_user`. The session rejects `policy` provenance supplied by a client, so only the arbiter can record an automatic approval.
5. Concurrency is session-serialised: the first answer for a `requestId` wins; a user answer or `take_over` aborts the review; a result that arrives after the request settled is dropped.
6. Reviewer error, timeout, abort or staleness → `awaiting_user` with `review: unavailable`. Never allow, never deny.

Headless runs the same arbiter; at `awaiting_user` with no interactive client it applies today's non-interactive fallback (deny, or allow under `--auto-approve`), replacing the separate advisor + `NonInteractiveApprovalPolicy` double pass. ACP forwards only `awaiting_user` requests to the editor.

A process that dies while a request is `reviewing` reopens the turn as interrupted, as for any pending interaction (`layers.md`, "The engine waits instead of calling up"). On replay, `interaction_review_started` without an outcome projects as `awaiting_user` with `review: unavailable`, for turn- and task-owned requests alike.

### 4. Session status and protocol

- Session status gains `reviewing_approval`; only `awaiting_user` sets `awaiting_interaction`. ACP's `requires_action` and the control read model therefore change only when a human is needed.
- The interaction is published to clients when it reaches `awaiting_user` (or carries `approvalState: 'reviewing'` for clients that declare support). Clients that ignore the new field — control socket, Discord, ACP v2, `serve` — never see a request the arbiter is still reviewing.
- `WireInteraction` gains `approvalState`, `review?: { verdict, riskLevel, summary, concern, recommendation }` and `grants`. A live event `interaction_awaiting_user` marks the transition; the snapshot carries `approvalState`, so a client attaching mid-wait sees it. Command `take_over { requestId }` (the TUI's Esc) skips the review.
- Notifications subscribe to `interaction_awaiting_user`; the `liveApprovalIds` bookkeeping in `launch-tui.tsx` goes away.

## Helping the user instead of tiring them

Prompt count and prompt quality both drive rubber-stamping: many prompts teach "press y", and prompts that only show a raw command give nothing to judge. Each mechanism is owned by the arbiter or descriptor, so it applies to every client.

1. **Fewer prompts, uniformly.** Every reviewable tool is auto-resolvable under the one threshold (see owner decisions).
2. **Reviewer remembers this session's human decisions.** Fed from facts (arbiter step 2), so a command the user just approved or rejected informs the next verdict.
3. **Deterministic standing-grant offers.** The session counts human approvals per canonical subject. On the second approval of the same subject in a session, the prompt pre-highlights the narrowest standing grant the descriptor offers (session folder, project host). No LLM involved.
4. **Lead with the judgement, not the payload.** Extend the reviewer output with `summary` (what the action does, one line), `concern` (the specific reason it was not auto-approved) and `recommendation` (`allow` / `deny` / `inspect`). The prompt shows these first and the raw command below.
5. **Friction proportional to risk.** When the reviewer's `riskLevel` is `high` or it recommends `deny`, the default option is Deny and the one-key `y` shortcut is disabled.
6. **Typeahead guard.** Keys in the same input chunk as, or within a short window after, the prompt's first render do not approve. Readiness already exists as the harness `.approval` signal.
7. **Measure it.** `interaction_reviewed` and the resolution fact record verdict, final decision, who decided and decision latency: prompts per turn, auto-resolve rate, human-overrides-reviewer rate, sub-second approvals of `high` risk. Ships with phase 3; the `jq` recipe ships once it has been run.
8. **Batching (later).** One reviewer request and one grouped prompt for sibling calls of a model response. `interaction_required` carries one request per event today, so this needs a grouping key and a multi-answer prompt; it follows the other items.

## Migration

Each phase is shippable and deletes what it replaces.

1. **Canonical subjects.** Add `canonicalPath` (local/remote aware); switch `SessionAccessState`, `resolveSessionReadFolder`, `isReadPreApproved`/skill roots and `resolveOutsideWorkspaceEdit`. Deletes the four local `~`/symlink variants. Permission-boundary change: independent verifier.
2. **Descriptor + single app-level decision function.** Add `ToolApproval` for every approval-capable tool and one `decideApproval()` in `src/app/lib/` that implements `routeApproval` + `acceptVerdict`; all three current review paths call it. Behaviour converges across TUI, ACP and headless here, including the owner-decided widenings. Deletes `isAutoApprovableTool`, `isExplicitShellRequest`, the TUI pass allowlist, `unsandboxedOnly` and the per-tool branches in `approvalFor`/`nestedGrants`.
3. **Arbiter + protocol.** Move `decideApproval()` unchanged into `src/session/approval/approval-arbiter.ts` and run it from the session; add facts, `reviewing_approval` status, wire fields, `interaction_awaiting_user`, `take_over`, provenance enforcement and metrics. Deletes the review effect and race bookkeeping in `approval-host.tsx`, `reviewLiveApproval`, ACP's review call, the headless double pass and `liveApprovalIds`.
4. **Fatigue features.** Human-decision evidence, grant offers, reviewer `summary/concern/recommendation` (prompt version bump), risk-proportional keys, typeahead guard; batching last.

## Verification

- `routeApproval`/`acceptVerdict`: persistent bounded generated properties under the [generated verification pilot](../../experiments/generated-verification/README.md) — "a `hardGate` never routes to review unless mode is `always`", "a review error or staleness never yields allow", "a mode change during review never yields allow", "the route is identical for turn, task and nested owners".
- `canonicalPath`: generated properties over `~`, `~user`, relative, symlinked and missing-tail spellings, and remote paths staying lexical.
- **Behaviour matrix.** Before phase 2, capture surface × mode × tool × gate → outcome on `main`; after phase 2, diff it. Every changed cell must be one of the owner decisions above.
- E2E: keep `tests/cli/approval-mode.e2e.test.ts` and `tests/clients/tui/approval-review.integration.test.tsx`; add a cross-client scenario (TUI, ACP, headless reach the same decision), concurrency (user answer vs review pass, `take_over` from a second client, mode flip mid-review), crash during `reviewing` then resume, an old-protocol client, and headless running a single evaluation.
- Phases 1–3 change a permission boundary: independent verifier per the `verification` skill, plus a live pass of `.handoff/live-verification-2026-11-15.md` scenarios A–F.

## Open decisions for the owner

- **Hide or show options while reviewing.** Today the TUI hides them (`3726fff51`); this design keeps hiding plus `take_over`.
- **Risk-proportional keys** (item 5) change muscle memory for high-risk prompts.
- **Standing-grant threshold** of two approvals per subject per session.

## Review disposition

An independent review (Fable 5.2, 2026-11-15) raised nine findings. The owner directed that findings aiming to tighten auto-approval rules be dismissed.

| Finding | Disposition |
|---|---|
| 1. Threshold misattributed to TUI; keep per-surface postures | Factual correction adopted (Problem table). Per-surface postures **dismissed**: one threshold, owner decision. |
| 2. Outside-workspace edits should stay human-only | **Dismissed**: owner decision. |
| 3. Decision sites before open, headless double pass, nested, status | Adopted: descriptor owns `requirement`; nested and headless folded in; `reviewing_approval` status. |
| 4. Staleness guards lost | Adopted (arbiter step 3). |
| 5. Protocol compatibility and provenance | Adopted (§4, arbiter step 4). |
| 6. `canonicalPath` breaks remote workspaces | Adopted (§2); phase 1 gets a verifier. |
| 7. Fatigue: don't preselect grants, hide LLM `allow` text, key on deterministic risk | **Dismissed** as tightening. Adopted: wire human decisions into the reviewer; defer batching. |
| 8. Phase churn, naming, labels in tools | Adopted: single app-level function in phase 2; descriptor renamed; labels stay in clients. |
| 9. Verification gaps | Adopted except the prompt-injection scenario, which only supports a tightening already dismissed. |
