# Contract 09 — Execution-root authority and workspace lease

Status: **audit draft — not owner-reviewed.** Owner: `ExecutionContext` and the
worktree admission tool (`source/services/execution-context.ts`,
`source/tools/system/worktree.ts`), with the active-root fallback in
`source/services/workspace/active-workspace-root.ts`.

## 1. Contract

The seam is the active-workspace fallback shared by `ExecutionContext`,
worktree admission, and safety or filesystem consumers that cannot receive an
`ExecutionContext` directly. A leased root changes sandbox write authority,
command-safety project membership, approval/read defaults, and path completion
across otherwise separate owners. `enterWorkspace` and `pin` remain distinct
adapters with deliberately different publication semantics; this contract does
not merge them.

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C9.1 | A successful parent workspace lease publishes its root to the active-root fallback; rejected admission does not publish a root. | Commands, file completion, approvals, or sandbox writes continue describing the previous checkout after a worktree switch, or a rejected request retargets the session. |
| C9.2 | Consumers that default their root derive the currently leased root, including sandbox write allowlisting and command path-risk classification. | A command is classified against the main checkout while it runs in a leased worktree, or writes are allowed in the wrong checkout. |
| C9.3 | A child `ExecutionContext.pin` does not publish or retarget the parent fallback. | A concurrent child changes the parent session's command-safety, completion, approval, or write authority. |
| C9.4 | Entry resolves only against the runtime-issued worktree list and refuses ambiguous or unavailable candidates. | An invented, stale, or ambiguous name silently selects the wrong directory or a missing checkout. |
| C9.5 | Parent root transitions refuse while jobs run beneath the old root. | A running background job keeps writing to the old root while the parent appears to have switched, producing split or corrupted work. |
| C9.6 | A workspace lease never calls `process.chdir`. | A process-global cwd mutation retargets unrelated background jobs and every caller that relies on the process cwd. |

The publisher invariant is intentionally by convention, not an uncallable
capability:

> `ExecutionContext.enterWorkspace` and `exitWorkspace` are the sole
> production publishers by convention. `publishActiveWorkspaceRoot` remains an
> exported test/reset escape hatch, so code does not enforce an uncallable
> single-writer capability.

## 2. Owners

- **Admission enforcement:** `resolveEnterWorktree` and
  `resolveExitWorktree` in `source/services/workspace/worktree-transition.ts`,
  using the runtime-issued list and running-job snapshot.
- **Lease and publication enforcement:** `ExecutionContext.enterWorkspace`,
  `exitWorkspace`, and `ExecutionContext.pin` in
  `source/services/execution-context.ts`; the fallback getter and its test/reset
  publisher are in `active-workspace-root.ts`.
- **Root consumers:** each consumer listed in §4 owns its local policy while
  taking the active-root default. Contract 05 C5.5 still owns fail-closed
  sandbox policy; Contract 09 owns which leased root is supplied to that policy.
- **Recovery:** the worktree tool reports typed admission outcomes and leaves
  the context unchanged on rejected admission; the caller retries after jobs
  settle or after correcting the worktree name.

## 3. Execution paths that share the contract

- `enter_worktree` and `exit_worktree` admission and publication.
- Root-level shell execution: sandbox filesystem allow-write construction,
  sandbox environment defaults, and project network allow-store defaults.
- Command-safety path classification for shell approval and auto-approval.
- File completion cache loading and invalidation across root transitions.
- Approval/read defaults, session access state, protected-hook checks, and
  conversation-result workspace projection.
- Agent scope resolution when no explicit workspace root is supplied.
- Status-bar Docker project-grant lookup and presentation.
- Child worktree pinning, which must remain run-local and non-publishing.

## 4. Identities and state crossing the boundary

- The parent session's home root is `process.cwd()` (or the remote directory
  in remote mode); an active local workspace is an absolute leased path.
- `activeRoot` is the process-local fallback state. It is read dynamically by
  default arguments and helpers, rather than captured when a module is loaded.
- A runtime-issued `GitWorktree` record supplies the path, branch, and
  availability/prunable state used by admission. A directory or branch name is
  an input selector, not an authority to supply an arbitrary path.
- `ExecutionContext.pin(root)` stores a child-local root without publishing it;
  `enterWorkspace(root)` stores and publishes the parent root.

### Verified default-root consumers

The source audit verified the following production consumers of
`getActiveWorkspaceRoot()` or its file-service wrapper:

- `source/services/agent-runtime/scope-resolver.ts:64` — implicit agent scope.
- `source/services/approval/approval-decision-executor.ts:261,282` — project
  allow-read persistence and approval decision cwd default.
- `source/services/approval/session-read-access.ts:16` — session read base-dir
  default.
- `source/services/conversation/conversation-result-builder.ts:372` — active
  workspace result projection.
- `source/services/file-service.ts:32,167,182-199` — completion scan and
  root-sensitive cache.
- `source/services/session/session-access-state.ts:24,32,36,40` — read/edit
  base-dir defaults.
- `source/tools/utils.ts:14,152` — path and protected-hook defaults.
- `source/utils/shell/command-safety/path-analysis.ts:145` — project
  membership for path-risk classification.
- `source/utils/shell/sandbox/sandbox-env.ts:49` — sandbox cwd default.
- `source/utils/shell/sandbox/sandbox-network-store.ts:96,105` — project
  network allow-store defaults.
- `source/utils/shell/sandbox/sandbox-policy.ts:433` — realpath-resolved
  sandbox workspace and write allowlist.
- `source/components/layout/StatusBar.tsx:13,70` — active-root Docker
  project-grant lookup for status-bar presentation.

This is the verified current source-audit inventory, not a claim that these
three new tests exhaustively prove every current or future consumer. The
characterizations target the public boundaries owned by file completion,
sandbox policy, and command-safety classification; the remaining consumers are
source-audited here and retain their own local tests.

## 5. Settlement semantics

### Entry

The exact admission settlement union is:

`entered | already_active | not_found | ambiguous | unavailable | busy`

`entered` is the only successful transition and is followed by
`ExecutionContext.enterWorkspace`, which publishes the selected root.
`already_active` is a successful no-op. The other outcomes reject or defer
admission and do not publish a new root.

### Exit

The exact admission settlement union is:

`exited | not_in_worktree | busy`

`exited` releases the parent lease and returns to its home root;
`not_in_worktree` is an idempotent no-op; `busy` refuses the transition while
jobs remain under the active root.

### Child pin and other outcomes

`pin` is synchronous and either returns a local context or throws for a
relative root; it has no published fallback settlement. These operations have
no asynchronous cancellation, retry, or provider-style unknown external
settlement. An `ambiguous` entry result is an admission refusal, not an
ambiguous filesystem effect: no lease is published and callers must choose a
new selector. A thrown invalid-root or remote-mode rejection likewise leaves
publication unchanged.

## 6. Observability

- `enter_worktree` and `exit_worktree` return explicit human-readable messages
  derived from their typed outcome; busy messages include the running job IDs
  and commands.
- The active root is observable through `getActiveWorkspaceRoot()` and through
  the selected root in `ExecutionContext.getCwd()` and `getActiveWorkspace()`.
- Sandbox configuration exposes its effective `filesystem.allowWrite` list;
  command safety exposes the structured `SafetyStatus` classification.
- A diagnosis showing completion entries, allow-write paths, or path-risk
  results from the home checkout after an accepted lease indicates a C9.1/C9.2
  publication/defaulting violation. A child pin changing those values indicates
  C9.3. A process cwd change indicates C9.6.

## 7. Public boundary under test

- `ExecutionContext.enterWorkspace`, `exitWorkspace`, `pin`, and
  `getCwd`/`getActiveWorkspace`, with the fallback getter, in
  `source/services/execution-context.test.ts` and
  `source/services/workspace/active-workspace-root.test.ts`.
- `resolveEnterWorktree`, `resolveExitWorktree`, and
  `resolveWorkerWorktree` in `source/services/workspace/worktree-transition.test.ts`.
- `getWorkspaceEntries` in `source/services/file-service.test.ts` (G2).
- `createSandboxRuntimeConfig` in
  `source/services/workspace/workspace-lease-authority.test.ts` (G5), with
  Contract 05's broader sandbox policy tests retaining the fail-closed policy
  boundary.
- `analyzePathRisk` and `SafetyStatus` in
  `source/services/workspace/workspace-lease-authority.test.ts` (G6), with
  the path-analysis suite retaining the broader classification matrix.
- `createWorktreeToolDefinitions` in `source/tools/system/worktree.test.ts`
  (enter/exit tool coupling and publication boundary).

## 8. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence | Status |
| --- | --- | --- |
| Fallback with no lease | `source/services/workspace/active-workspace-root.test.ts` — `falls back to the process cwd when no workspace is leased` | covered |
| Successful parent publication | `source/services/workspace/active-workspace-root.test.ts` — `entering a workspace publishes the leased root to code that cannot reach the context` | covered |
| Rejected entry does not publish | `source/services/workspace/active-workspace-root.test.ts` — `does not publish a root when entry is rejected` | covered |
| File completion follows a lease and returns after exit | `source/services/file-service.test.ts` — `getWorkspaceEntries follows an active lease without an explicit cache refresh` | covered |
| Sandbox default allow-write follows a lease | `source/services/workspace/workspace-lease-authority.test.ts` — `sandbox allowWrite follows the leased root when cwd is omitted` | covered |
| Command path classification follows a lease | `source/services/workspace/workspace-lease-authority.test.ts` — `command path classification follows the leased root when no cwd is supplied` | covered |
| Parent versus child pin publication | `source/services/execution-context.test.ts:110-126` — `pin leases a root without publishing the process-wide active workspace`; `pin does not retarget a parent session context that entered a different root` | covered |
| Runtime worktree admission outcomes | `source/services/workspace/worktree-transition.test.ts` — entered, already-active, not-found, ambiguous, unavailable, and busy entry cases; exited, not-in-worktree, and busy exit cases | covered |
| `enter_worktree`/`exit_worktree` tool coupling | `source/tools/system/worktree.test.ts:24-40,58-71` — `enter_worktree` publishes the selected root and `exit_worktree` releases it; rejected transitions leave the context unchanged | covered |
| Parent transition never calls process.chdir | `source/services/execution-context.ts:17-87` source audit; no production `process.chdir` in the lease implementation | source-audited; no dedicated characterization |
| All default-root consumers | §4 source audit inventory; the three new tests cover representative public boundaries, not exhaustive future-consumer behavior | source-audited; not an exhaustive test claim |

The existing execution-context tests already provide the stronger parent-versus-
child case required by C9.3. No G4 test is added. The existing active-root and
worktree-transition suites provide fallback/publication and C9.4/C9.5 outcome
coverage; the new tests fill G2, G5, and G6 only.

## 9. Verification commands

Focused command (the packet gate):

```sh
NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority test \
  source/services/workspace/active-workspace-root.test.ts \
  source/services/workspace/worktree-transition.test.ts \
  source/tools/system/worktree.test.ts \
  source/services/execution-context.test.ts \
  source/services/file-service.test.ts \
  source/services/workspace/workspace-lease-authority.test.ts \
  source/utils/shell/sandbox/sandbox-policy.test.ts \
  source/utils/shell/command-safety.path.test.ts
```

The packet also requires
`pnpm --dir /home/qduc/term2/.worktrees/sb08-workspace-authority typecheck`, the
corresponding `pnpm --dir ... exec prettier --check` over the four changed files,
and `git -C /home/qduc/term2/.worktrees/sb08-workspace-authority diff --check`.
A full `NODE_ENV=test pnpm --dir ... test` is a broader
audit gate and is recorded only if feasible; provider black-box is not required
because this packet changes neither a provider, bridge, run loop, registry, nor
non-interactive production path.

## 10. Known gaps and classification

- The active-root publisher is conventionally single-writer, not capability-
  enforced, because the exported publisher is required for deterministic test
  reset. **Classification: intentional test/reset escape hatch; no product
  defect proven.**
- The three new tests characterize file completion, sandbox write allowlisting,
  and command path classification. They do not prove exhaustiveness over every
  default-root consumer listed in §4. **Classification: bounded coverage
  statement, not a product defect.**
- `process.chdir` absence is source-audited rather than exercised by a runtime
  mutation test. **Classification: source-audit coverage gap; no product defect
  proven.**
- Contract 05 C5.5 remains the owner of fail-closed sandbox behavior; this
  record does not duplicate or broaden that policy. **Classification: explicit
  cross-contract boundary, not a gap.**
