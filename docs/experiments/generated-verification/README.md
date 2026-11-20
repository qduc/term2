# Generated edge-case verification pilot

This opt-in method searches bounded input spaces using fast-check, not an LLM.
The user explicitly authorized persistent generated checks as an exception to the
traditional permanent-unit-test ban. This is not a restored example-based suite.

## Use it on a real change

Read the production contract before choosing a property. Run the installed command
from the repository root after installing dependencies:

```sh
pnpm verify:generated --seed 424242
pnpm verify:generated --target history --runs 1000
pnpm verify:generated --help
```

The default is 1,000 cases per property, with at most 30 generated actions or
entries per case. An entry can invoke several production methods or expand into several transcript items. These are
sampling budgets, not exhaustive coverage or a proof. No credentials, external provider/model calls, or network calls are used by the checker. Production code runs in process;
the queue driver only records dispatches at the external executor boundary. Opaque checks run real adapters with an in-memory SDK-client boundary that captures the serialized request.

JSON stdout records revision/dirty state, seed, counts, shrinks, elapsed checker
time and minimized failures. `--output FILE` also saves JSON, refusing to overwrite
an existing file. Package-manager diagnostics may appear on stderr. Exit 0 means
sampled properties passed, 1 means a counterexample, 2 means invalid invocation or
infrastructure failure. Startup/package-manager time is outside `runtimeMs`. The launcher uses Node’s
`tsx` import loader, without the tsx CLI’s IPC-listener requirement. Use equals
syntax for negative seeds (for example, `--seed=-2147483648`); generated replay
commands include it automatically.

For failure triage, preserve the JSON, inspect whether the property follows the
actual production contract, then use its `replay` command at the same source and
dependency revision. `--property`, `--seed`, `--path` and `--runs` reproduce the
shrunk failure. A dirty revision alone is not a reconstructible snapshot: retain
the diff or commit it. Replay paths depend on property/generator/fast-check versions.
Do not weaken an invariant to silence a supported defect. Fix confirmed defects
or obtain human agreement to defer them. Independently verify high-risk fixes.

## Current scope

- `approval.decision-table` and `approval.arbiter-settle` (`--target approvals`)
  include `unattended`: nothing but a question waits for a person, hard gates,
  unreviewable tools and (unless `reviewEscapes`) sandbox escapes are refused
  without a review, the surface route agrees with the table, and a non-approval
  follows the mode current at settle. `approval.unattended-task-limit` drives
  generated refusal/approval sequences through `DirectBackgroundInteractions`:
  each refusal is opened and closed by policy in one step, and the denial stops
  the task exactly at 3 consecutive or 10 total.

- `native-log.single-source` (`--target native`): generated identity-specific
  tool bodies and escaped arguments through actual log create/read/reopen and
  continuation segments, including ordinary/structured provider results, user
  input echoes, reasoning/opaque metadata, identical/framed/distinct display,
  terminal reconstruction after history replacement, and torn tails. Checks
  exact hydrated facts and every large semantic string leaf in generated
  same-turn facts against physical string leaves (including ref framing).
  `text_delta`/full `history_replaced` remain approved literal exceptions.
  This bounded vocabulary is not exhaustive schema coverage or a process-kill/
  CLI/provider journey; focused controls are still required.

- `history.pair-projection`: structured, unique Responses-style call IDs, JSON
  arguments, arbitrary result text, missing results and an orphan result.
  `projectProviderHistory` promises non-mutation and idempotence;
  `dropUnpairedFunctionCalls` promises complete-pair retention/orphan removal.
- `queue.serial-actions`: generated public submit, completion, failure, removal,
  edit, resume, discard and stale-completion sequences compared at every step to
  an independent serial FIFO model. The empty-pause invariant is explicit in
  `QueueController.#cancel` and interrupted-active restoration: no retained work means idle, so future
  input is not blocked behind an empty pause.
- `queue.restore-pause`: generated valid saved queue records and pause reasons;
  empty saved pauses must admit fresh work, while nonempty saved queues retain
  their payloads and pause reason without replay on construction.

- `opaque.lane-isolation`: sentinel-bearing native payloads pass through real
  OpenAI/Grok Responses and Chat Completions adapters plus the Codex converter.
  Foreign lanes cannot reach captured SDK input; compatible own payloads and
  ordinary content survive. Responses/Codex backend-origin pins are checked.
  Chat checks lane tags only. Disputed legacy `openai-compatible` -> Grok
  acceptance is excluded, not approved or changed.
- `opaque.turn-attribution`: generated sequences of chat-completions turns, each
  with or without tool calls, prose and an encrypted reasoning payload, produced
  by the real adapter and replayed through the real history bridge
  (`historyToInput`). Cases either use unique call ids or restart them per
  response. With unique ids a tool turn's payload sits either in completion
  order or after its own results. Turns must replay in order, each as exactly
  one assistant message holding exactly its own calls, its text and only its
  own payload, followed by its own results; the turn stamp must not reach the
  wire. Text-only steps are followed by a user message, as a run
  ends there; legacy unstamped payloads are not generated.

- `approval.grant-identity` (`--target approvals`): a session read or edit
  folder grant (`SessionAccessState`) given in a generated spelling — absolute
  or relative, through a symlinked alias, with `./` or `er/../` noise — covers
  generated spellings of files, folders and missing paths beneath it, and never
  covers a sibling outside it or a symlink inside it (resolving, dangling, or a relative dangling link reached through a symlinked folder) that leads outside.
- `approval.remote-stays-lexical`: `canonicalPath` with `remote: true` equals the
  lexical path for generated segment lists, so SSH paths never consult this
  host's filesystem.
- `approval.decision-table`: generated request shapes (tool, question,
  explicit-user, denied-read, Docker, offered grants), modes before and after
  review, reviewer verdicts (approve/deny, risk, authorization, confidence,
  error, missing, throw) and aborts, through `describeApproval`,
  `routeApproval` and `decideApproval`. A hard gate never routes to review; no
  review happens outside `auto`/`advisory`; an approval only follows a usable
  verdict that clears the one threshold (approved, `llm` source, low or medium risk, explicit or implied authorization, high confidence) in `auto` with the mode unchanged and no
  abort, and answers with the request's one-time grant when it offers one.
- `approval.arbiter-settle`: `ApprovalReviews` with a generated route at open and
  at settle, review outcome (approved, rejected, throws) and a person's stop
  before the result. It starts a review only when routed, settles at most once
  and never after a stop, announces `started` then `settled` exactly once, and
  passes an approval only when the review approved and the current generation
  would still let a review answer the request (`mayApprove`: mode `auto`; a
  generation that only advises does not count).
- `approval.expand-home`: `expandHome` expands `~` and `~/…` only; `~user/…` stays
  literal.

The `compaction.plan-cut`, `compaction.unsafe-pairs` and `continuity.debt-filter`
properties, plus `history.ledger-settlement`, `history.ledger-reconciliation`
and `journal.reconstruction`,
were retired with their unused pre-rewrite implementations in #197.
They did not exercise the live Session/engine path. Historical pilot evidence is
retained in the plans below.

Not covered: parallel command interleavings, persistence failures, live approval delivery,
steering, real provider transports, multi-call chat envelopes, full journal/crash
recovery, reused-call reopening policy, arbitrary malformed inputs, compaction
summary quality, full continuity selection, or disputed opaque compatibility.
Passing does not establish these behaviors.

Add a property only for a named supported contract and a meaningful generated
space. Keep runtime bounded, shrinks readable and failure output reproducible.
Use this when changing these boundaries; do not substitute it for required static,
integration, e2e, provider, or independent checks. Pilot acceptance and evidence
are tracked in [PLAN.md](PLAN.md).

The ledger rollout evidence and limits are in [LEDGER-PLAN.md](LEDGER-PLAN.md).
The remaining hotspot rollout is tracked in [HOTSPOTS-PLAN.md](HOTSPOTS-PLAN.md).
The default now samples sixteen properties (16,000 cases total); `--target history`
samples the three history properties. A recorded replay can report fewer cases
because it continues from a shrunk path, not a fresh full seed run.
