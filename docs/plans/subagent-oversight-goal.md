# Subagent Oversight — Goal

Status: **shipped.** All three features below are implemented; see the individual
plan documents. Retained for the rationale and acceptance criteria, not as pending work.

Originally: goal only. Each numbered feature gets its own plan document before any
implementation. This document defines what we are trying to achieve and how we will
know we got it, not how to build it.

## Why

Orchestrator mode gives the main agent outcome ownership and makes it the single point
of contact (`source/prompts/orchestrator.md`). Recent prompt work strengthened that
further: the orchestrator now overrules subagent recommendations, reports in its own
voice, and continues the work rather than announcing that a run finished.

Its authority now outruns its information. Three concrete gaps:

- **Thin results.** `SubagentResult` (`source/services/subagents/types.ts:74-88`) carries
  `finalText`, changed-file paths, and aggregate `{toolName, count}` pairs. No diffs, no
  tool arguments, no intermediate turns. The orchestrator is required to verify claims
  with diff/test evidence, but the result gives it none — it has to re-derive everything
  from the filesystem.
- **No peek.** The only tools are `run_subagent_async` and `get_subagent_result`
  (`source/agent.ts:233-236`), and the latter blocks until completion. There is no
  non-blocking way to learn anything about a live run.
- **No steer.** Nothing reaches a running subagent. Cancellation exists in the registry
  (`subagent-async-registry.ts:190-195`) but is wired only to the user's stop action.
  Worker continuation is blocked outright, so a worker heading the wrong way runs to
  completion regardless.

The sharpest symptom: **the user can currently see more than the orchestrator can.**
`subagent_tool_started` events stream tool names and arguments to the terminal
(`execution-runner.ts:192-201`) but never enter the parent's context. Mid-run, the user
watches the work while the orchestrator is blind to it — the exact inversion of single
point of contact.

## North star

The orchestrator should never have to tell the user "I don't know what it's doing" or
"I can't stop it." It should have enough visibility into, and control over, delegated
work to answer for that work as its own — without paying the context cost that
delegation exists to avoid.

That last clause is the binding constraint on all three features. Delegation is a
context-compression mechanism. Every byte we hand back to the parent spends the thing
we delegated to save. No feature here succeeds by moving the subagent's context into
the orchestrator's.

## 1. Richer subagent results

**Goal.** The result should carry enough evidence for the orchestrator to verify the
subagent's claim without re-deriving it, so report quality stops depending entirely on
the worker's prose discipline.

**Success criteria.**
- For a typical worker run, the orchestrator can satisfy the evidence bar in
  `orchestrator.md` ("changed-file or diff/commit evidence and relevant test output")
  from the result alone.
- A worker that does correct work but writes a vague summary no longer degrades the
  orchestrator's ability to verify it.
- Measured context cost per result stays within a stated budget.

**Non-goals.** Returning the full transcript. Returning raw tool outputs verbatim.

Claude Code's harness reaches the same conclusion from the other direction: it keeps the
full subagent transcript on disk but explicitly forbids reading it into the parent
("it will overflow your context window"), routing the parent to the structured tool
result instead. Enrichment means better structure, not more transcript.

**Questions the plan must answer.**
- What is the token budget for a result, and what gets truncated first when it is
  exceeded?
- Structured evidence fields (diff stat, validation command + exit status) versus a
  larger free-text report — which does the model actually use?
- Does the enriched shape need to stay backward-compatible for the logging path
  (`services/logging/conversation-log-events.ts`, `conversation-log-writer.ts`) and any
  persisted or replayed conversation state?
- Does `worker.md`'s prescribed report format become redundant, or does it stay as the
  narrative layer over structured evidence?

## 2. Peek

**Goal.** A non-blocking answer to "what is it doing right now," available to the
orchestrator at any point during a live run.

**Success criteria.**
- The orchestrator can answer a mid-run user question about a delegated task without
  blocking its own turn.
- At minimum, parity with what the UI already streams, at summary granularity.
- The async discipline does not regress: the new capability must not become a
  workaround that reintroduces blocking waits.

**Non-goals.** Streaming subagent tokens or full tool output into parent context.

**Questions the plan must answer.**
- Poll (a status tool the orchestrator calls) or push (progress notifications into the
  parent turn)? Push risks interrupting the orchestrator mid-task; poll risks it never
  looking.
- What granularity is genuinely useful — status and elapsed time, or last tool plus a
  progress hint? The registry already holds role, task, status, and timing.
- Does peek cover all runs at once, or one runId at a time?
- Non-blocking status on a *finished* run overlaps `get_subagent_result`. Where is the
  boundary?

## 3. Steer

**Goal.** Correct a live run instead of waiting for it to finish wrong — and let a
blocked subagent raise a question instead of giving up and reporting.

**Prior art.** Claude Code's own harness solves this with a message channel, not restart
semantics. `SendMessage` addresses an agent by name and delivers into it; the same
primitive resumes a *completed* agent from its transcript, and the receiving side is
push ("messages from teammates are delivered automatically; you don't check an inbox").
Cancellation is a separate tool (`TaskStop`), also addressable by name. Critically the
channel is bidirectional: a background agent can address the main conversation, so
inbound questions and outbound corrections are one mechanism rather than two.

This corrects an earlier assumption in this document. Cancel-and-relaunch is not the
honest primitive; a delivery channel is, and it is cheaper for us than it first appeared.

**Success criteria.**
- The orchestrator can redirect a live run with revised instructions, preserving work
  already done.
- A subagent that hits a genuine blocker can ask the orchestrator rather than
  terminating with a partial report.
- The orchestrator can still terminate a run it judges unsalvageable, and account for
  the partial work honestly.

**Non-goals.** Any subagent path to the user. Inbound messages address the orchestrator,
which then decides or escalates — the single-point-of-contact invariant is exactly what
makes a bidirectional channel safe here.

**Questions the plan must answer.**
- We already own half this machinery, pointed the wrong way: `SubagentNotificationStore`
  and `#deliverBackgroundSubagentNotifications` (`conversation-orchestrator.ts:560-603`)
  inject a system-initiated turn into the parent when a run settles. Inbound messaging is
  that path generalized past completions. Outbound delivery into a live subagent's turn
  loop is the genuinely new piece. How much of the existing path generalizes?
- **Addressing.** The precedent uses names, with the raw ID as fallback. Our runIds are
  opaque, and steering `run-1` versus `run-2` is poor ergonomics for a model running
  several at once. Naming is likely a prerequisite for this feature rather than a
  cosmetic addition — the plan should decide whether it lands here or earlier.
- Cancel and redirect are separate primitives in the precedent, with separate uses.
  Ship them together anyway, given cancel is a thin wrapper over
  `subagent-async-registry.ts:190-195`?
- The current policy blocks worker continuation entirely
  (`run-subagent-async.ts:154`). Steering makes that policy load-bearing rather than
  incidental — does it survive?
- What does a mid-run message do to a subagent's turn budget (`maxTurns`), and what
  happens if one arrives while that subagent has an approval pending?
- What happens to partial work on cancellation — is the worktree left dirty, and who
  reports that?
- The live-delivery semantics described above are read from tool schemas, not from
  documented behavior. Confirm empirically before building on them.

## Sequencing

**Peek → results → steer.**

Peek is the cheapest and closes the most visible gap: it is the one the user hits
directly by asking a question mid-run. Results enrichment is independent of the other
two and mostly plumbing and format design. Steer is last because it is the largest —
a new outbound delivery path, probably a naming scheme, and a generalization of the
existing notification path — and because its design depends on what peek surfaces: you
cannot sensibly redirect work you cannot observe.

## Shared constraints

- **Context budget.** Each plan states the parent-context cost of its feature and
  justifies it. This is the constraint most likely to be violated silently.
- **Prompt text is product behavior.** Per `AGENTS.md`, each feature ships with its
  prompt guidance and tests pinning the non-obvious parts, following
  `source/prompts/search-via-shell.test.ts` and `source/prompts/orchestrator-prompt.test.ts`.
- **TDD.** Tests first, per the `testing` skill.
- **Do not regress async discipline.** The "don't call `get_subagent_result` right after
  launching" rule is load-bearing and repeated in three places. Any new tool must be
  checked against the failure mode it guards.
- **Single point of contact is the invariant.** No feature should give a subagent a path
  to the user, or give the user a reason to route around the orchestrator.
