# Unattended approval: deciding without a person

**Status:** research and recommendation; no product change. Term2 claims were read against `f14058c` (v1.4.0). External sources were read on 2026-11-20; [Sources](#sources-and-how-far-to-trust-them) says which were read in full and which only through search summaries.

## Question

Can Term2 offer an approval mode in which a person is never asked, that is not `always`?

## Recommendation

Add an **unattended** mode that leaves the reviewer's approval threshold alone and changes where a non-approval goes: to the model, as a refusal it must work around, instead of to a person. Bound it with a refusal limit, refuse sandbox escapes by default, and snapshot the workspace each turn.

That is the whole build for a project of Term2's size; [How much security to aim for](#how-much-security-to-aim-for) gives the reasoning. Two further steps are recorded below and deferred until use shows they are needed: judging authorization from the user's words only, and a per-task envelope enforced by the sandbox.

## How much security to aim for

Term2 is a hobby project: one maintainer, users who opt in and run it on their own machines, no administrator and no compliance duty. That decides which threats are worth engineering against.

| Threat | How often | Aim | With what |
| --- | --- | --- | --- |
| An overeager agent or an honest mistake: deleted work, files touched outside the task | The common case | Prevent | The sandbox and a snapshot. Both are deterministic; neither involves a model |
| Prompt injection from content the agent reads | Rare, costly when it lands | Bound the damage; do not try to detect it | The sandbox's floors: no credential reads, no writes outside the workspace, network approved per host |
| An agent working against its own monitor (the 79% result below) | A lab threat model | Not attempted | Say so in the README |
| A hostile user, tenant separation, audit trails, admin policy | Not applicable to a single-user tool | Not attempted | Nothing |

Three rules follow.

**Rely on what does not need measuring.** A probabilistic defence is worth what its measured error rate says. Anthropic can publish 17% because it has 10,000 labelled calls and a red team. A one-maintainer project can keep neither current. The OS sandbox (taken whole from `@anthropic-ai/sandbox-runtime`) and a git snapshot hold whether or not anyone evaluates them. The security Term2 claims should rest on those two. The reviewer should be described as a convenience that catches mistakes.

**Hold one line: the sandbox escape.** Inside the sandbox a wrong decision costs workspace files, which a snapshot restores. An approved `unsandboxed` command is the one request where a wrong verdict gives host access with nobody at the keyboard. Unattended should refuse escapes by default, as workers already do (`rejectUnsandboxedSubagentShell`), with a setting for people who accept the risk. The lower-stakes crossings, a network host or a read outside the workspace, stay with the reviewer.

**Say what is not defended.** HarnessSecurity-Bench recommends that harnesses publish what each mechanism covers; for a hobby project an accurate README is the cheapest security feature there is. The residual to name: the reviewer may approve a network host (`sandbox_network_access` is reviewable), so an injected page could get one approved and send it whatever the workspace holds, a `.env` included. The standard read policy denies credential paths under the home directory, not files in the workspace.

This cuts the proposal below to steps 1 and 4:

- **Step 2 is deferred.** Splitting the reviewer's evidence needs a labelled set to show it helps, and keeping one current is the cost this project cannot carry.
- **Step 3 is deferred.** It is the most machinery, and its hand-written form already exists: project-level host grants and `sandbox.allowReadExtra`.
- **Step 1 loses two parts.** The refusal ledger defends against an agent that retries on purpose, and granting a parked refusal is interface work. The refusal, its reason and the limit stay.

## What a person does in Term2 today

`shell.autoApproveMode` has four values:

| Mode | Who answers an open request | When a person is asked |
| --- | --- | --- |
| `off` | person | every request |
| `advisory` | person, with the reviewer's verdict shown | every request |
| `auto` | the reviewer, when the verdict passes `acceptVerdict` in `approval-route.ts` | every other request |
| `always` | nobody: `shouldBypassToolApproval` means no request opens; the setting's schema description says it also disables `sandbox.enabled` | `ask_user` and `propose_goal` only |

Neither existing mode is unattended and judged. `auto` keeps a person as the destination for everything the reviewer does not pass. `always` removes the judgement and the sandbox together.

In `auto`, a request reaches a person for one of four reasons:

1. A hard gate in `describeApproval`: `question`, `explicit-user`, `denied-read`, `docker-host`.
2. The tool is not reviewable (`isAutoApprovableTool` is false).
3. The reviewer did not pass it: high risk, weak or unknown authorization, low confidence, or a RED classification (`source: 'system'`).
4. The review was unavailable: error, abort, or a mode change during the review (`decideApproval`, `ApprovalReviews.#stillRouted`).

Two facts about the current code shape the proposal.

**The sandbox already decides most shell calls.** On a local workspace with the sandbox enabled and available, the shell tool's `needsApproval` returns false for a default-sandbox command. Requests arise at the boundary: an `unsandboxed` escape, a network destination, a path outside the workspace, Docker host control, a retry after a denied read. Everything is a request only when the sandbox is off or unavailable, or the session runs over SSH.

**Surfaces with no person already refuse, each by its own rule.**

| Surface | What it does with a request nobody can answer |
| --- | --- |
| Headless, `decideInteraction` in `src/app/tool-surface.ts` with `NonInteractiveApprovalPolicy` | Denies with a reason the model sees. Under `--auto-approve`: allows non-shell tools (an MCP tool only when allowlisted), denies RED, lets a recorded review rejection stand, never answers a run check-in, `propose_goal` or Docker host control |
| Headless client, `decideHeadlessApproval` | Without `--auto-approve`, denies every approval. With it, still denies `sandbox_network_access` and medium- or high-risk shell |
| Workers, `SubagentToolPolicy.wrapShellTool` | Sets `needsApproval: () => false` and returns an `Error: command blocked for safety` string; `rejectUnsandboxedSubagentShell` refuses every escape |

So "refuse and let the model continue" exists on two surfaces. No surface limits how often it repeats, and the rules differ.

## What shipped elsewhere in 2026

Three products converged on one shape: contain first, put a model at the boundary, return its denial to the agent, stop after repeated denials.

| | Claude Code auto mode | Codex Auto-review | Cursor Auto-review |
| --- | --- | --- | --- |
| Skips the model | read-only allowlist; edits inside the project | whatever the sandbox and command rules already allow | allowlisted calls; commands that run in the sandbox |
| Goes to the model | shell, web fetch, external tools, subagent spawns, files outside the project | requests that would otherwise stop for a person | calls that do not use the sandbox (shell, MCP, fetch) |
| On denial | returned as the tool result with an instruction to "find a safer path, don't try to route around the block" | agent told to find a safer approach | not established from what I could read |
| Limit | 3 consecutive or 20 total denials, then a person is asked; headless terminates the process | 3 consecutive, or 10 within the last 50 reviews of the turn, then the turn is aborted; `/approve` lets a person grant one recent denial for one retry | not established |

Details from Anthropic's engineering post, the only one of the three read in full:

- **The classifier is blind to the agent.** It sees user messages and tool-call payloads. Assistant text is stripped so the agent "can't talk the classifier into making a bad call"; tool results are stripped as "the primary prompt-injection defense". Including both "caused a drop in performance on our overeagerness testset".
- **Authorization is narrow by rule.** "Everything the agent chooses on its own is unauthorized until the user says otherwise."
- **Two stages.** A single-token filter told to err toward blocking, then a reasoning pass over what it flagged; the second prompt differs only in its final instruction, so it is mostly a cache hit.
- **Published accuracy.** False positives 0.4% on 10,000 real tool calls. False negatives 17% on 52 real overeager actions and 5.7% on 1,000 synthetic exfiltration attempts.
- **Delegation.** A handoff check at delegation may deny, because "inside the subagent, the orchestrator's instruction is the user message, so tasks look fully authorized". A check at return only warns.

These mechanisms are the ones Term2's plans set aside. `llm-auto-approve-evaluator-upgrade.md` lists the rejection circuit breaker and denial-rationale injection under "Out of scope", and `approval-arbiter.md` names "auto-*denying* on the reviewer's word" as a non-goal. Those exclusions fit a mode with a person behind it. They are the missing parts of a mode without one.

## Why that shape is not enough alone

A per-action model verdict is a usability layer. The evidence says it is a weak last line:

- Anthropic's own miss rate on real overeager actions is 17%, and the post says auto mode "is not a drop-in replacement for careful human review on high-stakes infrastructure".
- Anthropic's red-team paper (arXiv 2609.19587, abstract through search) reports that an agent writing an injection aimed at the monitor ran arbitrary shell commands in 79% of trials against Auto Mode and Guardian (the source-tree name of Codex's reviewer). Splitting an attack across agents or contexts and malicious compaction also worked. Escaping and framing each transcript turn "substantially mitigates" the injection.
- Rehberger's August 2026 chain got code execution past auto mode in 3 to 4 of 5 tries (secondary coverage; small sample).
- HarnessSecurity-Bench (arXiv 2610.07639, search summary) finds that auto-approval sharply raises attack success, isolation and allowlists reduce harm at a utility cost, and allowed commands leave unauthorized operations reachable by other execution paths.
- "Approval Laundering" (arXiv 2609.38983, abstract) classifies six ways the executed action differs from the approved one: scope, argument, temporal, tool, delegation, semantic.

Without a person, whatever the reviewer passes has to be bounded by something that does not read text the agent controls.

## Ideas that do not put a model last

| Idea | Mechanism | Evidence | Weakness |
| --- | --- | --- | --- |
| Task-scoped policy (Conseca, Progent) | Generate a least-privilege policy from the user's request before untrusted content is read; check each action against it deterministically; a denial carries a rationale | Conseca: 12.0 of 20 tasks completed, against 14.0 with no policy, 12.2 with a static permissive policy and 0.0 with a static restrictive one. Progent on AgentDojo: attack success 39.9% to 1.0% with model-written policies, utility 76.3% against 79.4% | Over-restriction: Conseca denied creating a summary file the task needed |
| Capability budget (Meta's Agents Rule of Two) | A session holds at most two of: untrusted input, sensitive data, external effect | A design rule, not a measurement | Says what to forbid, not how to finish the task |
| Undo and confinement (GoEX) | Where an undo exists, validate after the action; where none exists, confine the damage | Design paper; 2026 overlay tools (cowbox, the Mirage staged-write proposal) use it to ease a person's review, not to replace it | External effects have no undo |
| Resampling (Ctrl-Z) | When a monitor flags an action, draw another from the same agent before falling back | 83.2% safety against 72.7% for deferring to a trusted model, at 95% usefulness (secondary summary) | A fresh draw helps a steered agent as much as an honest one |

## Proposal

Decide capabilities once from the user's own words, let the sandbox enforce them, and turn every remaining "no" into a refusal the agent must work around. A person is never a state a request can be in.

Step 1 is the mode. Steps 2 to 4 each remove a way for it to fail and can ship separately. Steps 1 and 4 are the recommended build; the scope section above says what is deferred and why. The full design is kept so that a later need does not start from nothing.

### 1. A refusal outcome in the arbiter

`routeApproval` returns `'review' | 'ask_user'`, and a request whose review does not approve is opened for a person. Unattended adds a third settlement, **refused**: the request closes by policy with a reason, and the reason is the tool call's result.

The approval threshold does not move. `acceptVerdict` stays the one threshold, as the arbiter plan's owner decisions require. Only the destination of a non-approval changes.

- **Hard gates refuse without a review.** Docker host control, denied-read retries and `explicit-user` requests are not the reviewer's to grant today and stay that way.
- **An escape refuses by default.** This is the one place unattended is stricter than `auto`, for the reason in the scope section. A setting restores the `auto` behaviour.
- **An unavailable review refuses** with a different reason from a rejection. A fragment of Codex's documentation makes the same distinction: a timeout alone is not proof that the action is unsafe.
- **The refusal names the subject and the reason, and asks for a different approach.** The reviewer's `reasoning` already states the specific reason approval is required.
- **A refused path or host stays refused for the turn (deferred).** Key a ledger on the canonical subject from the arbiter plan (`canonicalPath`, the normalised host and port) and answer a repeat without a model call. Without a person, a retry is a second draw from a probabilistic reviewer; the Ctrl-Z result is that redrawing raises the pass rate. The ledger cannot catch a reworded shell command, whose subject is its text. The limit below covers that case.
- **A limit ends the turn.** After N consecutive or M total refusals the turn stops with a report of what was refused and why; headless exits non-zero. The shipped values (3 consecutive; 20 per session at Anthropic; 10 of the last 50 reviews per turn at OpenAI) are starting points, not calibration. This is a new guard: the `guard-design` skill and `guard-ledger.md` apply.
- **Refusals are recorded, not lost.** They are recorded with the review, as approvals are (`review` on `interaction_opened`), and listed when the turn ends. Letting a later user message grant one, as Codex's `/approve` does, is deferred.
- **Budget and goals are unchanged.** Run check-ins and `propose_goal` are never answered by policy today.

This replaces the three per-surface rules in the table above with one, which is goal 1 of the arbiter plan.

### 2. Judge authorization from the user's words only

The reviewer's prompt (`buildPrompt`) carries `<recent_activity>`: assistant messages and tool results, rendered by `getCompactHistoryLine`. The evaluator upgrade added tool results on purpose, to reduce false rejections. That evidence is also text the agent, a fetched page or a file can write. This exposure exists in `auto` today; unattended raises its cost because runs are longer and nobody reads the transcript as it grows.

Anthropic measured the opposite choice and found it better on overeager actions. Term2 can take the benefit without losing the evidence, because the decision path (`evaluateDecisionShadow`) already asks two questions per request, `risk_<i>` and `authorization_<i>`:

- **Authorization** reads the user's messages and the action. No assistant text, no tool results.
- **Risk** keeps the recent activity.

A tool result can then make an action look less risky, but it cannot create permission, and `acceptVerdict` needs both. Two known gaps: `latestUserRequest` supplies only the latest user message, so earlier instructions reach the reviewer only through the mixed activity section; and the chore-model fallback asks both questions in one call.

Adopt this only on a measured gain. The evaluator harness design in `docs/plans/approvals-and-sandbox/llm_auto_approve_harness/design.md` describes the labelled set this needs.

### 3. A task envelope enforced by the sandbox

Conseca and Progent match tool calls against a generated policy. Matching shell text is where that fails (the over-restriction and alternative-path findings above). Term2 does not need to match text, because its sandbox enforces by object: paths through `createSandboxRuntimeConfig` (`allowWrite`, `allowReadExtra`, `denyRead`), hosts through the network approval store.

When a turn is submitted, derive an envelope from the user's message and the project's standing grants: extra readable roots, extra writable roots, network hosts. Apply it as session-scoped grants. Readable roots and hosts have session-scoped grants today (`SessionAccessState.allowReadFolder`, the `allow-session` network answer). `CreateSandboxRuntimeConfigOptions` has no option for extra writable roots, so those need new plumbing.

- **Inside the envelope nothing asks**, and no command string was approved. The kernel and the proxy allow the access. The argument, temporal and tool classes of approval laundering do not arise for these actions.
- **The grant is decided before the agent reads anything**, by a model that sees only the user's words. That is Conseca's injection resistance.
- **Escapes get rarer.** A host or an outside path is the usual reason for an `unsandboxed` request, the riskiest thing the reviewer may pass. Both become sandboxed grants.
- **The floors stay.** `EXACT_PROTECTED_WRITE_PATHS`, `SUBTREE_PROTECTED_WRITE_PATHS` and the credential read denials in `sandbox-policy.ts` are not grantable by an envelope.
- **Freeze on untrusted input.** Once the session has read web content, an MCP result or a file outside the workspace, the envelope stops growing: a new host is refused without a review. This is the Rule of Two as one deterministic check.

An envelope that is too narrow produces refusals, which step 1 handles. One that is too wide is the risk; show it in the transcript when the turn starts.

### 4. A workspace snapshot per turn

Inside the sandbox the shell runs unreviewed and can destroy uncommitted work. A person at the terminal would notice; unattended, nobody does. `/rewind` restores the conversation only (`rewind-command.ts`: "next does not track the files a turn touched").

Before an unattended turn's first mutation, write the workspace to a commit under a private ref using a temporary index. Probed on 2026-11-20 in a scratch repository with one modified, one staged and one untracked file: `GIT_INDEX_FILE=<copy> git add -A`, `git write-tree`, `git commit-tree`, `git update-ref` left `git status` and the real index unchanged, and the commit held all three files.

A snapshot kept in the workspace's own repository guards against mistakes, not against an agent that deletes the ref: the workspace is in the sandbox's `allowWrite`, and for a linked worktree `resolveGitWorktreeWritePaths` allows the shared `refs` and `objects`. Keeping the snapshot outside the sandbox's writable paths closes that gap. As built, the snapshot lives in a shadow repository under term2's state directory, which closes it (build brief, decision 7).

The snapshot covers what can be undone. Steps 1 to 3 confine what cannot. It also gives the end-of-turn report something concrete: the files changed since the snapshot and how to restore them.

## What stays true

- Unattended also runs without a sandbox; the owner decided this and the build brief records it. The reviewer is then the only layer. The evidence above does not support that as a security claim, so the user-facing documentation has to say it plainly.
- The reviewer is not a security boundary. Vendors describe theirs the same way.
- Workers keep their stricter rule: no escape at all.

## Learn from use

The arbiter plan notes that metrics are not recorded beyond the review on the open fact, and a metrics pipeline is out of proportion here. The end-of-turn refusal list is the measurement: the maintainer's own unattended runs show what gets refused. Three things to read from it before reviving a deferred step:

1. **How often a run is refused**, by tool, hard gate and review kind.
2. **How many refusals the maintainer would have approved.** Those are the wrong ones. Anthropic reports that users accept 93% of manual prompts, so expect most.
3. **The reasons, ranked.** If hosts and outside paths dominate, step 3 is worth reviving. If reviewer caution dominates, step 2 and the threshold are.

## Open decisions for the owner

The build brief, [`docs/plans/approvals-and-sandbox/unattended-approval.md`](../plans/approvals-and-sandbox/unattended-approval.md), proposes a default for each of these and is where a changed answer is recorded.

1. **A fifth mode value, or `auto` with no person attached?** A separate value is clearer: people who choose `auto` expect to be asked.
2. **Does `ask_user` still reach a person in an interactive unattended session?** It is a question, not an authority decision; `always` keeps it.
3. **Limit values and scope** (turn or session).
4. **May an unattended review approve `unsandboxed-once`?** Recommended: refuse by default, with a setting. This departs from the one-threshold decision for this one grant, because unattended removes the person who could notice and interrupt.

## Sources and how far to trust them

Read in full:

- Anthropic, "How we built Claude Code auto mode" (2026-03-25): https://www.anthropic.com/engineering/claude-code-auto-mode

Search summaries only (arxiv.org, openai.com, ai.meta.com and cursor.com did not resolve from the research environment). Check a figure against the page before relying on it:

- OpenAI, Codex Auto-review: https://developers.openai.com/codex/concepts/sandboxing/auto-review
- Cursor, run modes and agent sandboxing: https://cursor.com/docs/agent/security/run-modes.md, https://cursor.com/blog/agent-sandboxing
- Anthropic, "Red-Teaming Auto Mode": https://alignment.anthropic.com/2026/red-teaming-auto-mode/ (arXiv 2609.19587)
- Rehberger's auto mode bypass, through the Cloud Security Alliance note: https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-automode-prompt-injection-2026/
- HarnessSecurity-Bench: https://arxiv.org/abs/2610.07639
- Approval Laundering: https://arxiv.org/abs/2609.38983
- Conseca, "Contextual Agent Security: A Policy for Every Purpose": https://arxiv.org/abs/2501.17070
- Progent: https://arxiv.org/abs/2504.11703
- Meta, "Agents Rule of Two": https://ai.meta.com/blog/practical-ai-agent-security/
- GoEX: https://arxiv.org/abs/2404.06921
- Ctrl-Z: https://arxiv.org/abs/2504.10374
