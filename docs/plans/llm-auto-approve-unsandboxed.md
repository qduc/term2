# LLM Auto-Approval for Unsandboxed Shell Requests (sandbox-enabled only)

**Status:** Implemented. `requiresHumanShellApproval` takes an
`opts.llmMayEvaluateUnsandboxed` flag that lifts the forced-human gate for unsandboxed
shell calls (`source/services/approval/shell-sandbox-approval.ts:44-52`), and
`ShellAutoApprovalResolver` derives it from settings and carries an `unsandboxed` flag
per command (`source/services/approval/shell-auto-approval-resolver.ts:64-125`).
Retained for the design rationale.
**Last updated:** 2026-07-31

---

## Objective

When the sandbox is **enabled**, let the existing LLM auto-approval path
(`shell.autoApproveMode` = `advisory` | `auto`) evaluate `shell` calls that pass
`sandbox: "unsandboxed"`. When the sandbox is **disabled**, nothing changes:
an unsandboxed request keeps today's forced-human-approval behavior, exactly as
it behaves now.

## Context (verified against current code)

The LLM auto-approval path exists and works for sandboxed commands:

- `shell.autoApproveMode`: `off` (default) | `advisory` | `auto`
  (`settings-schema.ts:200`, cycled via `/auto-approve`).
- `ShellAutoApprovalResolver` (`shell-auto-approval-resolver.ts`) reads the mode
  via `getAutoApproveMode()`; `shouldAutoApprove()` returns true only when
  mode === `auto` AND the advisory is `approved: true` AND `source === 'llm'`.
  RED heuristic results (source `system`) can therefore never auto-approve.
- `evaluateShellAutoApprovalAdvisories` (`shell-auto-approval-evaluator.ts`)
  classifies each command and asks the chore model
  (`agent.choreModel` / legacy `agent.autoApproveModel`).
- Decision wiring: `conversation-result-builder.ts:180-229` (single calls) and
  `tool-approval-batch-coordinator.ts:122-143` (batched interruptions).

**The blocker for unsandboxed:** `requiresHumanShellApproval()`
(`shell-sandbox-approval.ts:38-54`) returns `true` for any unsandboxed shell
call (`isUnsandboxedShell`, line 4). That becomes `forceHumanApproval`, and both
decision sites short-circuit **before** the policy registry and the LLM advisory
are consulted:

- `conversation-result-builder.ts:149` -> skips registry (line 186) and advisory
  (line 204).
- `tool-approval-batch-coordinator.ts:107` -> forces `decision = 'prompt'`
  (line 130).

`needsApproval` in `tools/system/shell.ts:306-308` returns `true` for
`sandbox: "unsandboxed"` unconditionally — keep it that way: the approval flow
must always engage; only the decision layer relaxes.

**Sandbox-off semantics today:** with `sandbox.enabled === false` the Shell
Sandbox prompt section is omitted (`prompt-constructor.ts:61-62`), but an
explicit `sandbox: "unsandboxed"` call still triggers the same forced human
prompt ("wants to run in unsandboxed mode:"). This behavior is preserved
verbatim (the design constraint below).

## Design constraint (user decision)

> The relaxation applies **only** when the sandbox is enabled. When the sandbox
> is off, nothing changes.

Behavior matrix after the change:

| `sandbox.enabled` | `shell.autoApproveMode` | `shell` with `sandbox:"unsandboxed"` |
|---|---|---|
| `false` | any | forced human prompt, no registry, no advisory — **unchanged** |
| `true` | `off` | forced human prompt, no registry, no advisory — unchanged |
| `true` | `advisory` | LLM advisory fetched and shown in the prompt; human decides |
| `true` | `auto` | LLM advisory fetched; `approved && source==='llm'` -> auto-approve, else prompt |

Docker host-control approvals remain forced-human in all cells (see D1).

## Design decisions

### D1. Scope: unsandboxed branch only

Relax only the `isUnsandboxedShell` branch of `requiresHumanShellApproval`.
Docker host control (`isDockerHostControlShellApproval`) stays forced human
always. They are disjoint in practice anyway: Docker host control requires the
default local sandbox (`shell.ts:449-451` errors on `sandbox !== 'default'`),
so an unsandboxed Docker command never executes.

### D2. Eligibility lives on `ShellAutoApprovalResolver`

Both decision call sites already hold `shellAutoApproval`; neither holds
`settingsService`. Add one capability to the resolver (and its
`DelegatingShellAutoApprovalResolver` override, mirroring `getAutoApproveMode`):

```ts
isUnsandboxedApprovalEligible(): boolean {
  const mode = this.getAutoApproveMode();
  const sandboxEnabled = this.deps.settingsService?.get<boolean>('sandbox.enabled') !== false;
  return sandboxEnabled && (mode === 'advisory' || mode === 'auto');
}
```

Both settings are read per call (consistent with the existing per-call
`sandbox.enabled` read in `shell.ts:298`), so mid-session toggles apply
immediately. Zero new dependency wiring.

### D3. Policy registry stays skipped for unsandboxed — always

Keep the registry out of the unsandboxed path in every cell of the matrix
(including ineligible ones). Only the LLM advisory can auto-approve a sandbox
escape. Rationale: registry auto-approval is unconditional policy written for
sandboxed execution; letting it silently cover unsandboxed escapes widens the
automated approval surface beyond what was asked. The existing test
(`conversation-result-builder.test.ts:268`) stays green.

Concretely, both decision sites gain an unconditional guard on the registry
branch: `&& !isUnsandboxedShell(toolName, parseResult.arguments)`.

### D4. The advisory LLM is told the command runs outside the sandbox

`evaluateShellAutoApprovalAdvisories` receives a per-command `unsandboxed`
flag; when set, the evaluation prompt notes: "This command will run OUTSIDE the
sandbox with host access." `SHELL_AUTO_APPROVAL_INSTRUCTIONS` gains a matching
clause and `SHELL_AUTO_APPROVAL_PROMPT_VERSION` is bumped. The RED heuristic
still short-circuits before the LLM, so the worst cases never reach it.

### D5. Skipped (user decision, 2026-07-31)

A mode-gated clause in the agent-facing Shell Sandbox addendum
(`prompts/shell-sandbox.md` / `shell-sandbox.ts`) was considered and explicitly
skipped. The addendum, the base model lines, and `prompt-constructor.ts` remain
unchanged; the status bar already surfaces the auto-approve mode.

### D6. Out of scope, deliberately unchanged

- **Subagents**: unsandboxed stays banned (`tool-policy.ts:460`,
  `subagent-manager.security.test.ts`). The relaxation is root-agent only.
- **Denied-read escape flow**: the post-execute 4-option prompt
  ("Run unsandboxed once") is orthogonal; unchanged.
- **Non-interactive `--auto-approve`**: its handler already auto-approves
  GREEN/YELLOW-with-approval regardless of sandbox/mode
  (`non-interactive.ts:131-175`); it is an explicit opt-in flag and stays as-is.
- **UI**: `ApprovalPrompt` header ("wants to run in unsandboxed mode") and the
  `LLMAdvisory` renderer already handle the prompted cells; no change needed.

## Implementation steps (ordered)

1. **`source/services/approval/shell-sandbox-approval.ts`** — add an options
   argument to `requiresHumanShellApproval`:
   `opts?: { llmMayEvaluateUnsandboxed?: boolean }`. The unsandboxed branch
   becomes `if (isUnsandboxedShell(toolName, args) && !opts?.llmMayEvaluateUnsandboxed) return true;`.
   Docker branch unchanged. Keep `isUnsandboxedShell` exported as-is.

2. **`source/services/approval/shell-auto-approval-resolver.ts`** — add
   `isUnsandboxedApprovalEligible()` (D2) and mirror it in
   `DelegatingShellAutoApprovalResolver`.

3. **`source/services/conversation/conversation-result-builder.ts`** —
   compute `const llmMayEvaluateUnsandboxed = shellAutoApproval.isUnsandboxedApprovalEligible();`
   and pass it into `requiresHumanShellApproval` (line 150). Guard the registry
   branch (line 186) with `&& !isUnsandboxedShell(toolName, parseResult.arguments)`.
   The advisory branch (line 204) then runs for eligible unsandboxed calls;
   `shouldAutoApprove` already enforces mode === `auto`.

4. **`source/services/approval/tool-approval-batch-coordinator.ts`** — same two
   edits at lines 107-113 (pass eligibility) and 132-133 (registry guard).

5. **`source/services/approval/shell-auto-approval-evaluator.ts`** — extend the
   command input type with an optional `unsandboxed?: boolean`; thread it into
   the prompt text; keep RED short-circuit as-is. Update
   `resolveAdvisoryForInterruption` to pass the flag from each sibling's parsed
   arguments (`argumentsText` JSON `sandbox === 'unsandboxed'`), including the
   no-callId single-command fallback path.

6. **`source/prompts/shell-auto-approval.ts`** — add the unsandboxed clause to
   `SHELL_AUTO_APPROVAL_INSTRUCTIONS`, bump `SHELL_AUTO_APPROVAL_PROMPT_VERSION`.
   (D5 is skipped: no change to `shell-sandbox.ts`/`.md` or
   `prompt-constructor.ts`.)

7. **Tests** (see below) — update the locking tests, add the matrix tests.

## Data flow

```
shell(sandbox:"unsandboxed") ──needsApproval──> true (unchanged, shell.ts:306)
        |
        v interruption
requiresHumanShellApproval(..., { llmMayEvaluateUnsandboxed })   [D1]
   |- sandbox off / mode off / docker  ──> forceHumanApproval=true  ──> human prompt (unchanged)
   `- sandbox on + mode advisory|auto ──> forceHumanApproval=false
            |
            v registry branch: skipped for unsandboxed (guard)      [D3]
            v advisory: resolveAdvisoryForInterruption (unsandboxed flag)  [D4]
                 |
                 |- mode auto + approved + source llm  ──> auto_approve ──> execute unsandboxed
                 `- else (incl. RED/system advisory) ──> approval_required with llmAdvisory
```

## Edge cases and failure modes

- **Mid-session toggles** (`sandbox.enabled`, `shell.autoApproveMode`): both
  read per call at decision time; no caching, no stale-state window.
- **Advisory fetch failure / malformed JSON**: resolver returns `undefined` ->
  `ShellAutoApprovalDecisionPolicy.decide` returns `prompt`; safe fallback,
  unchanged.
- **RED command with `sandbox:"unsandboxed"`**: heuristic short-circuits;
  advisory is `source: 'system'`, `approved: false`; never auto-approved;
  human prompt. Same as sandboxed RED.
- **Batched siblings with mixed sandbox modes**: per-command flag derived from
  each sibling's own arguments; advisory cache is keyed by callId so flags stay
  per command.
- **Docker host control + unsandboxed**: forced human (D1); execute additionally
  errors on `sandbox !== 'default'` (`shell.ts:449-451`) — no path executes.
- **`bash` tool alias**: `isUnsandboxedShell` covers `shell` and `bash`; both
  decision sites already gate on `shell || bash`.

## Tests

Update:

- `source/services/conversation/conversation-result-builder.test.ts:481`
  ("unsandboxed shell is not auto-approved by LLM advisory mode") — encodes the
  old "advisory never consulted" behavior (asserts `llmAdvisory` undefined).
  Rewrite into the matrix below; keep a sandbox-disabled variant asserting the
  old behavior verbatim.
- `source/services/conversation/conversation-result-builder.test.ts:268` —
  registry assertion stays green (D3), verify.
- `source/services/approval/tool-approval-batch-coordinator.test.ts:71` —
  verify against the new matrix (its settings mock defaults mode off -> still
  prompt).

Add (matrix, single-call and batch paths):

1. sandbox on + `auto` + unsandboxed + LLM `approved` (source llm) -> `auto_approve`.
2. sandbox on + `auto` + unsandboxed + RED -> prompt, system advisory, not
   auto-approved.
3. sandbox on + `advisory` + unsandboxed + LLM `approved` -> prompt with
   `llmAdvisory` attached.
4. sandbox on + `off` + unsandboxed -> prompt, no advisory (unchanged cell).
5. sandbox **off** + `auto` + unsandboxed + LLM `approved` -> prompt, no
   advisory (nothing changes).
6. sandbox off + `off` + unsandboxed -> prompt (unchanged cell).
7. Registry never auto-approves unsandboxed even when eligible (both decision
   sites).
8. Evaluator: unsandboxed flag reaches the prompt; `SHELL_AUTO_APPROVAL_PROMPT_VERSION`
   bumped (in `shell-auto-approval-evaluator.test.ts` /
   `shell-auto-approval-resolver.test.ts`).
9. `needsApproval` for unsandboxed remains `true` regardless of sandbox/mode
   (`tools/system/shell` tests) — regression pin.

## Acceptance criteria

- With sandbox on and mode `auto`, an unsandboxed call whose LLM advisory is
  `approved: true` (source `llm`) executes without a prompt; the UI marks it
  auto-approved (`markToolCallAsLlmAutoApproved` path).
- With sandbox on and mode `advisory`, the unsandboxed prompt shows the
  advisory and still requires a human decision.
- With sandbox off (any mode), unsandboxed behavior is byte-for-byte today's:
  forced human prompt, no advisory, no registry.
- Docker host control remains forced human; subagents still cannot run
  unsandboxed.
- RED commands never auto-approve in any cell.

## Risks / open questions

- **Test `:481` rewrite scope**: decide whether the sandbox-disabled variant
  duplicates the full setup or is extracted into a shared helper (existing test
  style leans toward inline setups; follow the file's convention).
- **`advisory` mode now spends a chore-model call on every unsandboxed
  request** (previously zero). Acceptable: unsandboxed is rare, and the RED
  short-circuit plus cache-by-callId bound the cost.
