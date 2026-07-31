# Implementation Tasks: LLM Auto-Approval for Unsandboxed Shell (sandbox-enabled only)

Tracked from `docs/plans/llm-auto-approve-unsandboxed.md`. Ordered by dependency.
Each is independently scoped so it can be handed to a separate agent/contributor.

**Global constraints (apply to every task):**
- The relaxation applies **only** when `sandbox.enabled !== false` AND
  `shell.autoApproveMode` is `advisory` or `auto`. Sandbox off ⇒ behavior is
  byte-for-byte today's (forced human prompt, no advisory, no registry).
- Docker host control stays forced-human always. Subagents stay banned from
  unsandboxed. Denied-read "Run unsandboxed once" flow is untouched.
- D5 (agent-facing prompt addendum) is **skipped** by user decision — do not
  touch `prompts/shell-sandbox.ts`, `prompts/shell-sandbox.md`, base model
  prompt files, or `prompt-constructor.ts`.
- Per the repo `testing` skill: write tests first where practical; run the
  narrowest test command that covers each change.

---

## Task 1: Gate function + eligibility capability

**Deliverable:** `source/services/approval/shell-sandbox-approval.ts`,
`source/services/approval/shell-auto-approval-resolver.ts`, new
`source/services/approval/shell-sandbox-approval.test.ts`.

**Scope:**
- `requiresHumanShellApproval(toolName, args, sessionId, sessionAccess,
  nestedCompatibility, opts?: { llmMayEvaluateUnsandboxed?: boolean })`: the
  unsandboxed branch becomes
  `if (isUnsandboxedShell(toolName, args) && !opts?.llmMayEvaluateUnsandboxed) return true;`.
  Docker branch unchanged. `isUnsandboxedShell` export unchanged.
- New `ShellAutoApprovalResolver.isUnsandboxedApprovalEligible(): boolean`:
  `sandbox.enabled !== false && (mode === 'advisory' || mode === 'auto')`,
  reading both from `deps.settingsService`. Mirror in
  `DelegatingShellAutoApprovalResolver` (same delegate pattern as
  `getAutoApproveMode`).

**Tests (new `shell-sandbox-approval.test.ts`, pure-function matrix):**
- unsandboxed + no opts ⇒ true (preserves today's behavior)
- unsandboxed + `llmMayEvaluateUnsandboxed: true` ⇒ false
- docker host control ⇒ true regardless of opts
- `shell` vs `bash` alias both covered; non-shell tool ⇒ false

**Done when:** gate matrix green; resolver method covered (resolver test file
already exists) incl. delegate fallback.

**Depends on:** nothing.

---

## Task 2: Single-call decision site (`conversation-result-builder`)

**Deliverable:** `source/services/conversation/conversation-result-builder.ts`
+ `conversation-result-builder.test.ts`.

**Scope:**
- Compute `llmMayEvaluateUnsandboxed = shellAutoApproval.isUnsandboxedApprovalEligible()`
  and pass it into `requiresHumanShellApproval` (line ~150).
- Guard the registry branch (line ~186) with
  `&& !isUnsandboxedShell(toolName, parseResult.arguments)` — unconditional,
  so registry never auto-approves an unsandboxed escape in any matrix cell.
- The existing advisory branch (line ~204) then runs for eligible unsandboxed
  calls; `shouldAutoApprove` already enforces mode === `auto` and
  `source === 'llm'`.

**Tests (`conversation-result-builder.test.ts`):**
- Rewrite the locking test at ~line 481 into the matrix; keep a sandbox-disabled
  variant asserting the old behavior verbatim (prompt + `llmAdvisory` undefined).
- Verify ~line 268 (registry) still passes unchanged.
- Add: sandbox on + `auto` + unsandboxed + LLM approved (source llm) ⇒
  `auto_approve`; sandbox on + `auto` + RED ⇒ prompt with system advisory;
  sandbox on + `advisory` + LLM approved ⇒ prompt with `llmAdvisory` attached;
  sandbox on + `off` ⇒ prompt no advisory; sandbox off + `auto` + approved ⇒
  prompt no advisory.

**Done when:** full matrix green; no other callers of `buildConversationResult`
regress (run the file's suite).

**Depends on:** Task 1.

---

## Task 3: Batch decision site (`tool-approval-batch-coordinator`)

**Deliverable:** `source/services/approval/tool-approval-batch-coordinator.ts`
+ `tool-approval-batch-coordinator.test.ts`.

**Scope:**
- Same two edits as Task 2: pass eligibility into `requiresHumanShellApproval`
  (line ~107) and guard the registry branch (line ~132) with
  `!isUnsandboxedShell(toolName, parseResult.arguments)`.
- Verify line ~71 test ("unsandboxed-shell" ⇒ prompt) still passes — its
  settings mock defaults to mode `off`, which must stay in the prompt cell.

**Tests:** batch-path counterparts of the Task 2 matrix; mixed sibling batch
(sandboxed auto-approved, unsandboxed evaluated with its own flag).

**Done when:** batch matrix green; existing coordinator suite green.

**Depends on:** Task 1.

---

## Task 4: Evaluator unsandboxed context + prompt version

**Deliverable:** `source/services/approval/shell-auto-approval-evaluator.ts`,
`source/services/approval/shell-auto-approval-resolver.ts`,
`source/prompts/shell-auto-approval.ts`,
`shell-auto-approval-evaluator.test.ts` / `shell-auto-approval-resolver.test.ts`.

**Scope:**
- Extend the evaluator command input type with optional `unsandboxed?: boolean`.
  When set, the per-command prompt text notes the command runs OUTSIDE the
  sandbox with host access. RED heuristic short-circuit unchanged.
- `SHELL_AUTO_APPROVAL_INSTRUCTIONS`: add the unsandboxed clause; bump
  `SHELL_AUTO_APPROVAL_PROMPT_VERSION`.
- `resolveAdvisoryForInterruption`: derive the flag per sibling from parsed
  `argumentsText` (`sandbox === 'unsandboxed'`), including the no-callId
  single-command fallback; pass through with each command.

**Tests:** flag reaches the prompt (unit); version bumped; resolver passes the
flag per sibling (mixed batch).

**Done when:** evaluator/resolver suites green.

**Depends on:** nothing (orthogonal to Tasks 1–3; can run in parallel).

---

## Task 5: Regression pin + full validation

**Deliverable:** none (validation only).

**Scope:**
- Pin `needsApproval` for unsandboxed stays `true` regardless of sandbox/mode
  (`source/tools/system/shell` tests) — add a test only if one is missing.
- Run, from the primary checkout or a worktree per the repo's parallel-work
  rules: typecheck, lint, and the test files touched by Tasks 1–4, then the
  broader `source/services/approval` + `source/services/conversation` +
  `source/services/session` suites.

**Done when:** no regressions beyond pre-existing failures; the matrix behavior
holds end-to-end (optionally verified via a manual interactive run with
sandbox on + `/auto-approve auto`).

**Depends on:** Tasks 1–4.
