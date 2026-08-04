# LLM Auto-approve Evaluator Upgrade Plan

Status: draft
Scope: `source/services/approval/shell-auto-approval-evaluator.ts` and its resolver / prompt
Related: `llm-auto-approve-unsandboxed.md`, `llm_auto_approve_spec.md`

## Background

This plan upgrades term2's shell auto-approval evaluator so the reviewer can make
better (safer, more explainable) decisions. It is informed by comparing term2's
evaluator against OpenAI Codex's enterprise "guardian" auto-review
(`codex-rs/core/src/guardian/`), which routes every boundary-crossing approval to
a separate reviewer agent.

The guardian is enterprise-grade machinery; most of it is deliberately NOT ported
here (see "Out of scope"). But a few of its *judgment* ideas are nearly free to
adopt because term2 already passes the full conversation history and already has a
structured-output pipeline.

### What the guardian does better (summary)

| Area | term2 today | Guardian |
| --- | --- | --- |
| Evidence | Only tool *calls*, no tool *results* | Tool calls + results (exact queried path/args + returned evidence) |
| Decision | `{ approved: boolean, reasoning }` | `risk_level × user_authorization → outcome`, policy-derived |
| Safety net | RED classifier hard-blocks; no gate on auto mode | "high risk needs strong authorization" threshold |
| Uncertainty | Truncation marker implies nothing | Truncated content must bias toward caution |
| Precedent | Prior approvals/rejections listed symmetrically | Post-denial override is narrow and re-reviewed; rejections are evidence |
| Cost | One-shot per batch, `reasoningEffort: 'none'` everywhere | Persistent cached review session with delta context |

## Out of scope (overkill for term2)

These guardian mechanisms are intentionally not ported:

- Persistent reviewer subagent + trunk/delta session + prompt-cache keys + ephemeral forks
- Per-turn rejection circuit breaker (3 consecutive / 10-in-50 counters)
- Read-only tool-call investigation loop inside the reviewer
- Managed `guardian_policy_config` / `[auto_review].policy` layering
- Denial-rationale injection back into the main agent loop

## Changes (ranked by leverage ÷ cost)

1. **Show the reviewer the tool outputs** — biggest fidelity win, ~free.
   `getCompactHistoryLine` (`evaluator.ts:94`) renders `[tool call] name args` and
   user/assistant text but never tool results, even though items already carry an
   `output` field (`provider-input.ts:19`). Add a `[tool result]` line so the
   reviewer sees what the agent already verified.

2. **Add risk + authorization to the output schema** — turns `approved` into a
   derived decision. Extend `SHELL_AUTO_APPROVAL_OUTPUT_SCHEMA` (`evaluator.ts:42`)
   with `riskLevel`, `authorization`, `confidence`; keep `approved` as the derived
   field so downstream code barely changes.

3. **Fail-closed auto-approve gate** — in `shouldAutoApprove` (`resolver.ts:67`),
   never auto-approve `high` risk, `weak`/`unknown` authorization, or `low`
   confidence; send those to a human even in `auto` mode.

4. **Make truncation and missing context scare the model** — prompt-only:
   truncated content should make the model more cautious, and unverifiable local
   state should default to reject.

5. **Bias the precedent** — prior human *rejections* are strong evidence, prior
   *approvals* are weak context (keeps the "prior approval never overrides policy"
   property).

6. **Reviewer continuity** — pass the last few evaluations back into the prompt
   (same mechanism as `manualDecisions`), without building a persistent session.

7. **Spend reasoning budget where it matters** — keep `reasoningEffort: 'none'`
   for GREEN/workspace-confined commands; use a low effort for `unsandboxed` or
   YELLOW-classified commands.

## Phased rollout

Each phase is a self-contained PR with tests and a "done when" gate. Order is by
dependency (Phase 3 depends on Phase 2; the rest are independent).

### Phase 1 — Tool results in the reviewer context
- **Borrows:** guardian's "keep calls + results" (`collect_guardian_transcript_entries`)
- **Files:** `shell-auto-approval-evaluator.ts`, `shell-auto-approval-evaluator.test.ts`
- **Changes:** add a `[tool result]` branch in `getCompactHistoryLine` for
  result-type items using the existing `output` field, truncated with
  `MAX_MESSAGE_CHARS`. Keep calls/results adjacent and ordered.
- **Tests:** new case asserting result content appears in the built prompt;
  extend the "bounded history" test (`evaluator.test.ts:441`).
- **Done when:** reviewer prompt shows calls + outputs; vitest evaluator suite green.

### Phase 2 — Truncation / missing-context caution (prompt-only)
- **Borrows:** guardian's "truncated content should make you more cautious, not
  less" + "lean conservative" (`policy_template.md` Evidence Handling)
- **Files:** `source/prompts/shell-auto-approval.ts`
- **Changes:** (a) `... [truncated N chars]` means partial data → treat gaps as
  uncertainty, not benignity; (b) if risk depends on unverifiable local state,
  default to reject (esp. unsandboxed/destructive).
- **Tests:** extend the "untrusted evidence" prompt test (`evaluator.test.ts:486`).
- **Done when:** wording present; evaluator + resolver suites green.

### Phase 3 — Risk × authorization in the output contract (keystone)
- **Borrows:** guardian's `risk_level × user_authorization → outcome`
- **Files:** `shell-auto-approval-evaluator.ts` (schema + `validateEvaluationBatch` +
  `EvaluationResult`), `shell-auto-approval.ts` (short rubric deriving `approved`),
  evaluator tests
- **Changes:** extend `SHELL_AUTO_APPROVAL_OUTPUT_SCHEMA` with
  `riskLevel: 'low'|'medium'|'high'`, `authorization: 'explicit'|'implied'|'weak'|'unknown'`,
  `confidence: 'high'|'low'`. `approved` stays the derived decision. Keep the
  structured → prompt-JSON → repair fallback working against the new schema.
- **Tests:** update golden JSON fixtures; add validation tests for new/absent
  fields and strict-mode failures.
- **Done when:** all three parse paths validate the new shape; suites green.

### Phase 4 — Fail-closed auto-approve gate + precedent bias
- **Borrows:** guardian's "high risk needs strong authorization" threshold +
  narrow override spirit
- **Files:** `shell-auto-approval-resolver.ts` (+ resolver and
  `approval-flow-coordinator` tests), `shell-auto-approval-evaluator.ts`
  (`buildManualDecisionsContext`)
- **Changes:** in `shouldAutoApprove`, require `approved && source==='llm'` **and**
  `riskLevel !== 'high'` **and** authorization not `weak`/`unknown` **and**
  `confidence === 'high'`; else human. In `buildManualDecisionsContext`, present
  prior rejections as strong evidence, demote approvals.
- **Tests:** gate matrix (high-risk-but-approved → human; weak-auth → human;
  low-risk+high-confidence → auto; RED unchanged). Rejection-precedent prompt test.
- **Done when:** resolver + coordinator suites green; behavior matrix asserted.

### Phase 5 — Scoped reasoning budget (cost knob)
- **Borrows:** guardian's reasoning model on review — kept opt-in and scoped
- **Files:** `shell-auto-approval-evaluator.ts` (`runPromptChat`/`runStructuredChat`),
  a `settingsService` setting (e.g. `agent.autoApproveReasoningEffort`)
- **Changes:** keep `'none'` for GREEN/workspace-confined; use `'low'` (or
  configured value) when `unsandboxed` or YELLOW. Default unchanged (additive).
- **Tests:** assert chosen effort per classification by mocking the agent client.
- **Done when:** effort selection covered; no behavior change for defaults.

## Checkpoints

- Run the full `source/services/approval` test directory before starting each phase.
- Run the `eval/` smoke (if in use) after Phases 1, 3, and 4.
- Every phase is revertible on its own.
