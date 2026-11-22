# Approval arbiter: current policy and ownership

This reference describes the approval routing implemented in
`src/session/approval/approval-route.ts`, `approval-arbiter.ts` and
`src/app/lib/approval-model.ts`. The original design proposed a per-tool
`ToolApproval` descriptor and extra durable review states; those are not the
current interface. Refusal and snapshot decisions are documented in
[unattended-approval.md](unattended-approval.md).

## Four policies, separate review display

`APPROVAL_POLICIES` expresses two decisions: whether a reviewer may approve,
and what happens when permission remains unresolved.

| `shell.autoApproveMode` | Reviewer policy | Fallback |
|---|---|---|
| `off` (default) | none | human |
| `auto` | auto | human |
| `unattended` | auto | refuse |
| `always` | none | bypass |

`shell.showReview` is independent and defaults to false. In `off`, true requests
an advisory review of eligible requests, but never authorizes execution. In
`auto` and `unattended`, review runs regardless of this flag. The flag controls
assessment visibility in human prompts, not recorded evidence. A reviewed result
retains its advisory and display flag on the durable open fact even when hidden.
Saved `advisory` settings migrate before validation to `off` and
`showReview: true`; live commands reject the retired mode with replacement
guidance. `--approval-mode` and `--show-review` set these separate preferences.
In a non-interactive run, `--auto-approve` raises `off` to `auto` unless
`--approval-mode` is given, and whatever the route leaves for a person is
refused ([headless-approval-redesign.md](headless-approval-redesign.md),
decisions 1 and 2).

Approval mode and `sandbox.enabled` are independent. Changing either preserves
the other. In particular, `always` leaves ordinary commands using the configured sandbox. ACP v1
has an explicit `unattended` mode; `assisted` maps to `auto` while preserving the
sandbox preference. The host's headless execution and ACP surface constraints
still apply; the table does not grant unsupported execution capabilities.

## Describe, route, settle

`approvalFor` and `nestedGrants` in `src/app/source-tools.ts` decide whether a
call needs an interaction and which grants it offers. These still have per-tool
policy checks. Existing eligible `always` bypasses can run before opening a
request; policy denials and unsupported escapes remain enforced there.

For an open request, `describeApproval` derives `ApprovalProfile` from its kind,
presentation, offered grants and the app's Docker/escape checks. Its hard gates
are questions, explicit-user decisions (including `propose_goal`), denied-read
retries and Docker host control. A question routes to `ask_user` in every mode;
other hard gates route to `ask_user`, or to `refuse` in `unattended`. They do not
route to review or runtime bypass. A non-reviewable request asks, or is refused
in `unattended`; `always` can bypass eligible non-hard-gated requests without
requiring reviewer eligibility.

`approvalRouteFor` maps the profile to `advise`, `decide`, `judge`, `ask_user`,
`refuse` or `bypass`. `advise` only informs a person, `decide` reviews then asks
on non-approval, and `judge` reviews then refuses on non-approval. An escape from
an enforcing sandbox is refused in `unattended` unless
`shell.unattendedEscapeReview` is true. With no enforcing sandbox, shell
requests go to the reviewer as in `auto`.

`decideApproval` uses one threshold (`acceptVerdict`): a non-error LLM assessment
must approve, rate risk low or medium, find explicit or implied authorization,
and report high confidence. No threshold or hard gate is relaxed by
`showReview`. A supported bypass makes no model call and returns
`{ kind: 'bypassed', approved: true, grant? }`.

Runtime bypass is necessary for requests raised during execution, including
sandbox network destinations and ACP foreground sandbox escapes. Settlement
records a policy approval with the request's exact one-time grant when offered:
`unsandboxed-once` takes priority over `network-allow-once`; otherwise the answer
is plain allow. No standing grant is synthesized. Background and Docker
host-control escapes remain unsupported and are rejected before routing.

## Ownership, evidence and races

`createAssistedApprovalReview` wires the tool-free evaluator into the shared
route. `ApprovalReviews` owns unopened requests for foreground and background
owners; nested `run_code` requests use the same policy. Clients render the result
rather than starting their own model review.

While a request is being reviewed, it is not durable and does not put the session
in an awaiting-user state. Clients receive the live `approval_review` transient;
a mid-review snapshot includes `reviewingApprovals`. The first review result,
human answer, takeover or cancellation wins. A process that dies during review
reopens with the unfinished call unanswered and the turn interrupted.

Settlement commits `interaction_opened` or `task_interaction_opened` with its
`review`. An approved result also commits its policy close and releases the
waiter. A non-approval opens for a person or records an unattended refusal. The
review is available on live open events and client-reduced pending interactions;
a snapshot reconstructed from session state carries the request without that
review. There is no durable `reviewing_approval` state or separate
`interaction_reviewed` fact.

`decideApproval` checks that the mode still matches after the model returns;
`ApprovalReviews` additionally asks the current generation's `mayApprove` and
checks the authority family before accepting an approval. A bypass can settle
only while the current route is still `bypass`; a reviewed approval needs
`decide` or `judge`. These routes all permit automatic answers, but a stale
bypass must not stand in for a review after switching to `auto` or `unattended`.
A non-approval follows the current mode at settlement.
Clients cannot supply `automaticApproval: true`: `answer` rejects it from every
caller. A client may still use policy source provenance, as headless does.

## Why the ownership was consolidated

The original implementation answered eligibility, thresholds and grants in the
TUI, ACP, headless and nested tool paths. A passing review could therefore
approve on one surface and prompt on another. Session ownership keeps pending
state, notifications, scoped grants and automatic provenance aligned. Canonical
path handling likewise removes conflicting tilde, relative-path and symlink
interpretations, while remote paths remain lexical.

The reviewer still lacks session human-decision evidence: the resolver is built
per request and its manual-decision recorder is not fed from durable facts. This
is a deferred feature, not an authorization source that callers may assume.

## Owner decisions already taken

- **One threshold everywhere.** A passing review auto-approves when today's `shouldAutoApprove` holds: mode `auto` or `unattended`, verdict approved, risk `low` or `medium`, authorization `explicit` or `implied`, confidence `high`. This loosens ACP v1 Assisted (from `low`-only, with `high`-risk and unsandboxed requests excluded) to match the TUI. Per-surface postures are not kept.
- **Every reviewable tool is auto-resolvable.** Outside-workspace edits (`create_file`, `search_replace`, `apply_patch`) and searches are auto-approved on a passing review, like `read_file` today.
- **The deterministic `risk: 'high'` on unsandboxed shell is an input to the reviewer, not a routing gate.** It travels as `boundary: 'host'`.
- ACP's session default stays `shell.autoApproveMode = off` (`approvalAlwaysAsks`); that is a mode setting, not a threshold.

## Deferred fatigue work and rationale

Prompt count and prompt quality both drive rubber-stamping: many prompts teach "press y", and prompts that only show a raw command give nothing to judge. These proposals explain the original design direction; they are not a list of current features. Uniform review eligibility is implemented, but session human-decision evidence, standing-grant offers, richer judgement fields, risk-proportional keys, the typeahead guard, metrics and batching remain deferred.

1. **Fewer prompts, uniformly.** Every reviewable tool is auto-resolvable under the one threshold (see owner decisions).
2. **Reviewer remembers this session's human decisions.** Proposed to be fed from durable human-decision facts, so a command the user just approved or rejected informs the next verdict.
3. **Deterministic standing-grant offers.** The session counts human approvals per canonical subject. On the second approval of the same subject in a session, the prompt pre-highlights the narrowest standing grant the descriptor offers (session folder, project host). No LLM involved.
4. **Lead with the judgement, not the payload.** Extend the reviewer output with `summary` (what the action does, one line), `concern` (the specific reason it was not auto-approved) and `recommendation` (`allow` / `deny` / `inspect`). The prompt shows these first and the raw command below.
5. **Friction proportional to risk.** When the reviewer's `riskLevel` is `high` or it recommends `deny`, the default option is Deny and the one-key `y` shortcut is disabled.
6. **Typeahead guard.** Keys in the same input chunk as, or within a short window after, the prompt's first render do not approve. Readiness already exists as the harness `.approval` signal.
7. **Measure it.** `interaction_reviewed` and the resolution fact record verdict, final decision, who decided and decision latency: prompts per turn, auto-resolve rate, human-overrides-reviewer rate, sub-second approvals of `high` risk. A metrics pipeline and its recipes remain deferred.
8. **Batching (later).** One reviewer request and one grouped prompt for sibling calls of a model response. `interaction_required` carries one request per event today, so this needs a grouping key and a multi-answer prompt; it follows the other items.

## Verification obligations

Permission-boundary changes require an independent verifier. The generated
approval properties cover routing and verdict authority; integration/e2e checks
must exercise surface behavior, scoped grants, hidden-but-recorded evidence,
mode changes during review, and saved-settings migration. Follow the repository
verification and testing skills; do not restore permanent example-based unit
tests. Historical review decisions below explain the threshold choices, rather
than specifying the current wire protocol or descriptor interface.

## Historical review disposition

These dispositions describe the original proposal, including descriptor and
protocol changes that were not implemented as proposed. The current ownership
and evidence sections above take precedence for implementation details.

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
