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

- `history.pair-projection`: structured, unique Responses-style call IDs, JSON
  arguments, arbitrary result text, missing results and an orphan result.
  `projectProviderHistory` promises non-mutation and idempotence;
  `dropUnpairedFunctionCalls` promises complete-pair retention/orphan removal.
- `history.ledger-settlement`: generated fresh call identities, dispatch/result
  observations, scoped/all stream interruption, rejection of never-dispatched
  calls, turn changes and export/import against an independent per-call model.
  C2.5 requires unobserved dispatched effects to remain unknown, not aborted;
  completed outcomes and out-of-scope calls must not change. This checks ledger
  bookkeeping, not execution or retry of real effects.
- `history.ledger-reconciliation`: generated partial transcripts and settled/open
  ledger entries with explicit user anchors and retry-attempt drift. C2.1/C2.2
  require one correctly ordered pair per settled call, preserved payloads and user
  ownership, idempotence and non-mutation. OpenAI/local replacement checkpoints
  prevent old ledger reinjection; model-request history starts at the last one.
- `queue.serial-actions`: generated public submit, completion, failure, removal,
  edit, resume, discard and stale-completion sequences compared at every step to
  an independent serial FIFO model. The empty-pause invariant is explicit in
  `QueueController.#cancel` and interrupted-active restoration: no retained work means idle, so future
  input is not blocked behind an empty pause.
- `queue.restore-pause`: generated valid saved queue records and pause reasons;
  empty saved pauses must admit fresh work, while nonempty saved queues retain
  their payloads and pause reason without replay on construction.

- `compaction.plan-cut`: generates genuine/synthetic user turns, parallel settled
  rounds, reordered results, payload sizes and optional trailing unpaid calls.
  Checks settled cut boundaries, exact prefix/tail partition, genuine-user
  preservation and nonmutation, not which heuristic cut is selected.
- `compaction.unsafe-pairs`: duplicate call identities and orphan results must
  produce the planner's documented blocked outcome without mutation.
- `continuity.debt-filter`: authoritative accepted segments feed real continuity
  debt into chained filtering. Checks exact selected outputs/order, missing and
  known-call orphan errors, debt retirement on new-user/reset/chaining-break,
  and stale-lineage candidate refusal after reset.
- `journal.reconstruction`: supported journal events reconstruct per-(turn,call)
  identity, statuses, JSON payloads, reasoning ownership and deterministic order,
  including call IDs reused across turns. Checks nonmutation and snapshot history
  isolation; not filesystem durability or executing recovered effects.
- `opaque.lane-isolation`: sentinel-bearing native payloads pass through real
  OpenAI/Grok Responses and Chat Completions adapters plus the Codex converter.
  Foreign lanes cannot reach captured SDK input; compatible own payloads and
  ordinary content survive. Responses/Codex backend-origin pins are checked.
  Chat checks lane tags only. Disputed legacy `openai-compatible` -> Grok
  acceptance is excluded, not approved or changed.

Not covered: parallel command interleavings, persistence failures, approvals,
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
The default now samples ten properties (10,000 cases total); `--target history`
samples the three history properties. A recorded replay can report fewer cases
because it continues from a shrunk path, not a fresh full seed run.
