# SB-00 Follow-up 5 — `retry/` cluster disposition

Status: **audit/docs — all 9 `source/services/retry/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads of every
member, line counts (`wc -l`), and cross-references to contract records (Contract 02
provider-input continuity and effect settlement; Contract 05 runtime guards and retention;
Contract 01 turn lifecycle) and plans (`chain-settlement.md`,
`tool-output-and-effect-safety.md`, `guard-ledger.md`). No test was executed; no claim of
passing tests is made. No production source changed; no new formal contract created; no
commit or merge.

## Disposition summary (9 files)

**Already owned — recorded, not re-owned (7):**

| File | Ownership |
| --- | --- |
| `recovery-executor.ts` (134) | `DefaultRecoveryExecutor` (`resume_stream`/`replay_turn`/`retry_fresh`/`terminate`). **Contract 02 §owners/§recovery** + **Contract 05 §Recovery/§Retry** (dispatched-but-unobserved calls settle as `unknown` with verify-before-retry, `recovery-executor.ts:60-89`; `tool-output-and-effect-safety` Milestone 2). Not re-owned here. |
| `recovery-policy.ts` (72) | `DefaultConversationRecoveryPolicy`. **Contract 02 §owners** (`recovery-policy`; chain_recovery/transport_downgrade → `retry_fresh` full-history) + **Contract 01 §Recovery** (retry before stream start, `recovery-policy.test.ts:39`). Not re-owned here. |
| `retry-classifier.ts` (84) | `DefaultRetryClassifier`. **Contract 02 §owners** (`retry-classifier`; bounded chain_recovery, `retry-classifier.test.ts:157`). Not re-owned here. |
| `retry-error-classification.ts` (463) | Transport/watchdog/model-error classifiers. **Contract 05 §Retry/§matrix** (watchdog timeouts retryable, `:365-455`; `:171` test) + **Contract 02 §4** + **Contract 03 §5** (`AmbiguousModelOutcomeError` explicitly non-retryable, `:336-347`). Not re-owned here. |
| `retry-event-presenter.ts` (155) | `RetryEventPresenter` (retry/transport-fallback presentation). **Contract 02 §4** (event strings `:81-89`, `:102-109`). Not re-owned here. |
| `conversation-retry-policy.ts` (143) | Model-error retry decisions (`decideRetry`, hallucination/parsing/behavior; `MAX_SUBAGENT_MODEL_RETRIES` consumed by `execution-runner.ts` per Contract 03 §5 retry-forwarding). **Contract 02/05 retry-policy family**. Not re-owned here. |
| `upstream-retry-policy.ts` (180) | Upstream/provider transient classification + backoff (rate-limit/connection/internal-server, `retry-after` headers, jittered backoff). **Contract 02 retry family** (provider continuity); shared with `providers/retrying-model.ts` and `providers/fetch/rate-limit-middleware.ts`; `guard-ledger.md:659` cites it as a programmer-error helper. Not re-owned here. |

**Not a seam (2):**

| File | Evidence |
| --- | --- |
| `retry-contracts.ts` (116) | Pure types + ports (`ClassifiedFailure`, `RecoveryPlan`, `RecoveryResult`, `RetryClassifier`/`ConversationRecoveryPolicy`/`RecoveryExecutor` interfaces). Types only — the shared vocabulary Contract 02/05 describe. |
| `retry-errors.ts` (8) | `AmbiguousModelOutcomeError` (`unsafeToReplay = true`). Single error class; non-retryability semantics already owned at `retry-error-classification.ts:336-347` (Contract 03 §5). |

**Formal contract (0 new):** every member already earned Contract 02/05 ownership or is
types-only; no port was added for export alone.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 2 clusters / **11 files** now undisposed at cluster level —
`hooks/` (10), `queue/` (1) — each carrying only the partial module-level dispositions
recorded in the SB-00 correction record. The `hooks/` and `queue/` rows were not started
in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly six docs files
(correction + follow-ups 1–4 + this record). No test suite applicable. Primary protected
dirt and HANDOFF.md byte-identical.
