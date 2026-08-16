# Service Boundary Contract Completion

Status: **CLOSED (program complete) 2026-08-16.** All remaining-SB slices A–K
landed on local `main` (no push). Slice I (memory C3.3 child-authority
extension + Contract 09 workspace-authority record, docs-only) landed
2026-08-16 as merge `53c70323` via `sb09-slice-i-docs`; closing inbox record
`REMAINING_SB_CLOSED` published to `/home/qduc/.agents/runtime/root-inbox/pending/`
(awaiting the President's harvest to `processed/`). The sections below are the
 dated audit record of each
workstream's drafts, gates, and retained proofs; treat pre-close
"awaiting owner decisions" wording as historical except where a hold is
re-stated here.

**Holds that still hold (unchanged):** the three President-held secret items
(Contract 10 credential-at-rest policy; Contract 10 `/settings` direct
credential-display reveal policy; SB-05 recursive ciphertext/evaluator
sanitization depth) and the Contract 10 R10.2 President-held retained red
(`it.fails`, byte-identical). Also still open: the separately authorized
follow-ups in the Consolidated Implementation Backlog below (SB-01 closed-union
repair, SB-03 role-interface partition, SB-02/SB-06 repair decisions, SB-04
runtime port hardening), Contract 10 selected-provider normalization and
corruption-recovery policy, Contract 12 residual queue decisions recorded as
retain-current, the three Contract 09 lease-following characterizations
(G2/G5/G6) unmerged in `.worktrees/sb08-workspace-authority` awaiting separate
authorization, the stricter memory strict-subset characterization unmerged in
`.worktrees/sb08-memory-local-disposition`, and Contract 12's record header
status line ("awaiting owner review") left stale by the owning lane's next
touch.

## Resume here

Program closed. Nothing is dispatched or in flight. Read the hold list above
before touching any listed area; none of the holds were resolved by the
program's closure.

- **Reviewed implementation awaiting owner decisions/integration:** SB-02 —
  conversation persistence and input-history durability Contract 08 in
  `.worktrees/sb02-conversation-durability-contract` on branch
  `sb02-conversation-durability-contract`. Pi completed the tests/docs-only
  correction handoff after the original agy sessions exhausted quota. The root
  coordinator independently reran the gates and a final Terra standards/spec
  review returned no findings. Contract 08 owns durable local bytes,
  descriptors, lockfiles, atomic replacement, torn records, sidecars, deletion,
  migration, and composer history; Contract 02 retains provider-facing replay
  meaning. No commit or merge is authorized yet.
- **SB-02 verification:** focused `NODE_ENV=test` suite passed 159 tests (154
  green, 5 retained expected failures); typecheck, Prettier, and
  `git diff --check` passed. The broader suite passed 483 files and 6,255 tests,
  with 5 expected failures and 2 skips; its sole failure is the unrelated
  settings-schema baseline (`maxModelRequestDurationMs` expected `0`, received
  `300000`).
- **SB-02 retained red proofs before repair:** typed unreadable project load
  (D1), distinct `last.json` staging per save (D3), corrupt-lock diagnostic
  distinction (D4), corrupt history quarantine (D5), and atomic history save
  preserving its predecessor (D6). Sidecar evidence is expressly limited to
  retained bytes after an unsettled orderly close; it makes no crash or
  power-loss durability claim.
- **Reviewed implementation awaiting owner decisions/integration:** SB-03 —
  `ConversationAgentClient` capability-consumer characterizations in
  `.worktrees/sb03-conversation-agent-client-capability` on branch
  `sb03-conversation-agent-client-capability`. The accepted disposition is:
  local role interfaces are sufficient for current consumers; retain the
  composite facade; broader type partitioning is deferred. Pi added 13 green
  public-owner tests across five existing test files; a final Terra review
  returned no findings. No commit or merge is authorized yet.
- **SB-03 verification:** focused `NODE_ENV=test` suite passed 5 files / 102
  tests; typecheck, Prettier, and `git diff --check` passed. The broader suite
  retained only the unrelated settings-schema baseline. Provider black-box is
  not applicable to this tests-only session/capability slice.
- **SB-03 classified gaps:** `setOnToolDispatch` and
  `useStandardServiceTierForNextRequest` are live dynamic calls implemented by
  the owned client but absent from the composite TypeScript declaration;
  `getStreamMaxRetries` is a dead compatibility lookup; and
  `getForegroundSubagentCandidate` is a declared/implemented method with no
  production consumer. These remain a separately authorized type/deletion
  decision, not product defects proven by this slice.
- **Reviewed implementation awaiting owner decisions/integration:** SB-05 —
  logging and provider-traffic Contract 07 in
  `.worktrees/sb05-logging-contract-tests` on branch
  `sb05-logging-contract-tests`. After multiple correction rounds, both Claude
  and Grok returned `SB05_POSTFIX_PASS`; the coordinator independently accepted
  the current tests/docs-only diff. No commit or merge is authorized yet.
- **SB-05 verification:** focused `NODE_ENV=test` suite passed 89 tests (80
  green, 9 retained expected failures); typecheck, Prettier, and
  `git diff --check` passed. The mandatory provider black-box gate first exposed
  one transient interactive public-hooks PTY timeout; that exact file then
  passed 3/3, and a complete rerun passed 19 files / 166 tests with 1 documented
  skip. The broader suite retains the unrelated settings-schema baseline
  failure recorded below.
- **SB-05 owner decisions before repair:** strict versus passthrough runtime log
  schema; typed `ILoggingService` metadata; trace/correlation override policy;
  async logging/backpressure; `#requestPaths` lifecycle cleanup; recursive
  ciphertext/evaluator sanitization; corrupt daily-index recovery; and fail-open
  settlement plus one structured warning for all four provider-traffic methods.
- **Reviewed implementation awaiting owner decisions/integration:** SB-06 — SSH
  transport contract record and public-boundary characterizations in
  `.worktrees/sb06-ssh-contract-tests` on branch `sb06-ssh-contract-tests`. The
  coordinator accepted the draft after correction rounds; no commit or merge is
  authorized yet.
- **SB-06 verification:** focused `NODE_ENV=test` suite passed 47 tests (37 green,
  10 retained expected failures); typecheck, Prettier, and `git diff --check`
  passed. The broader suite retained one unrelated settings-schema baseline failure,
  reproduced identically in the primary checkout (`maxModelRequestDurationMs` default
  expected `0`, received `300000`).
- **SB-06 owner decisions before repair:** timeout/`AbortSignal` ownership; typed
  known-versus-unknown remote-effect settlement; shell text helpers versus SFTP;
  reconnect listener cleanup and keepalive policy.
- **Reviewed implementation awaiting owner decisions/integration:** SB-07 —
  Contract 02 C2.6 adapter isolation extension in
  `.worktrees/sb07-c26-adapter-isolation` on branch
  `sb07-c26-adapter-isolation`. It adds three green public-boundary
  characterizations: Codex same-tag opaque refusal, AI SDK unary pre-vendor
  opaque refusal, and `RetryingModel` unary absence when its inner model has no
  unary capability. No production file changed; no commit or merge is
  authorized yet.
- **SB-07 verification:** the C2.6 focused gate passed 8 files / 170 tests and
  the historical Contract 02 gate passed 14 files / 355 tests; typecheck,
  Prettier, and `git diff --check` passed. The broader suite retained only the
  unrelated settings-schema baseline. Provider black-box first hit one
  `waitForRequests` PTY timeout in `provider-session-responses.blackbox.ts`; the
  exact file passed 27/27 on rerun and the complete rerun passed 19 files / 166
  tests with 1 skip. An independent Terra review passed after an explicit
  primary-versus-worktree hash check corrected a reviewer cwd attribution.
- **SB-07 owner decisions before type repair:** `ProviderFetch`/duplicate fetch
  alias typing, a common unary `getResponse` return shape, and whether a future
  non-Codex `RetryingModel` should forward unary behavior. No product defect was
  proven in this workstream.
- **Reviewed implementation awaiting owner decisions/integration:** SB-01 —
  `TurnWorkflow` outcome and continuation characterizations in
  `.worktrees/sb01-turn-outcome-contract-tests` on branch
  `sb01-turn-outcome-contract-tests`. It adds five green public-boundary
  characterizations and one retained public-boundary B1 proof to Contract 01;
  no production source changed and no commit or merge is authorized.
- **SB-01 verification:** the Contract 01 focused command passed 12 files / 345
  tests with 1 retained expected failure; the implementer also passed the
  seven-file owner gate (102 green plus B1), typecheck, Prettier, and
  `git diff --check`. The coordinator independently reran the 12-file command,
  typecheck, Prettier, and diff check; temporarily restored B1 to ordinary
  `it`, observed `Post-execute live run finished without a terminal outcome.`,
  then restored `it.fails`. The full suite retained only the known
  settings-schema baseline; an initially observed second failure did not recur.
  Two independent Terra reviews found and the implementer corrected Contract 01
  status/citation overclaims; the final review disposition is PASS.
- **SB-01 retained red and owner decision:** after a real post-execute pause is
  approved, a resumed stream that produces an auto-approvable shell interruption
  throws instead of settling a modeled `TurnOutcome`. The unique repair must
  settle that reachable `auto_approve` outcome (initial-path parity or an
  approval-required fallback); closed-union/type cleanup alone cannot flip it.
  Any production repair remains separately authorized.
- **Reviewed implementation awaiting owner decisions/integration:** SB-04 —
  `ConversationService` facade and `SessionRuntime` public-boundary
  characterizations in `.worktrees/sb04-facade-characterization` on branch
  `sb04-facade-characterization`. Exactly two new test files were added; no
  production source, contract, tracker, commit, or merge is authorized.
- **SB-04 verification:** the focused `NODE_ENV=test` command passed 5 files /
  96 tests with 2 retained expected failures; typecheck, Prettier, and
  `git diff --check` passed. The full suite has only the known
  settings-schema baseline (`maxModelRequestDurationMs`, expected `0`, received
  `300000`). The coordinator independently reran the focused/typecheck/format/
  diff gates and temporarily restored each red to ordinary `it`: queue-observer
  attachment failed `expected 1 to be greater than 1`; replacement retry
  callback failed `expected undefined to be type of 'function'`. Both were
  restored to `it.fails`. Two independent Terra reviews found only a forbidden
  concrete-class assertion; it was removed and the final review disposition is
  PASS.
- **SB-04 retained reds and owner decision:** reset must reattach the stable
  facade's queue observers to its replacement adapter and retry callback to its
  factory-owned replacement client. The two proofs are intentionally separate;
  repairing only one attachment cannot flip both. Any production repair or new
  port remains separately authorized.
- **Provisional contract namespace — coordinator reconciliation 2026-08-15:**
  Draft Contract 09 is workspace authority and execution-root lease; Contract
  10 is settings durability, migration, and sensitive bytes; Contract 11 is
  destructive approval authority; Contract 12 is queue persistence and
  recovery. Persistent memory remains a local disposition with a proposed
  Contract 03 C3.3 child-authority extension, not a new formal contract. These
  numbers are working assignments only: no record is owner-approved, and the
  public contracts README remains indexed through 05 until draft acceptance.
  This supersedes the old SB-08 workspace-local disposition and resolves the
  earlier provisional “Contract 09” collisions. **Contract 11 is no longer
  provisional:** the destructive-approval-authority audit record landed on
  local `main` 2026-08-16 as tests/docs-only under President grant (see
  `docs/contracts/11-destructive-approval-authority.md`; README indexed through
  11). Contracts 10 and 12 landed on local `main` 2026-08-16 (slices J and K,
  non-secret parts; the three secret items remain President-held). **Contract 09
  is no longer provisional either:** the workspace-authority record landed
  docs-only 2026-08-16 as slice I (see
  `docs/contracts/09-execution-root-authority-and-workspace-lease.md`; README
  now indexes 09 and 12). Persistent memory remains a local disposition; the
  proposed Contract 03 child-authority extension landed 2026-08-16 as **C3.7**
  in `docs/contracts/03-child-run-identity-authority-and-lifecycle.md`
  (read-access child subjects receive no mutating memory tool), docs-only, with
  the stricter strict-subset characterization still unmerged.
- **Reviewed implementation awaiting owner decisions/integration:** Contract 10
  settings durability, migration, and sensitive-byte characterization in
  `.worktrees/sb10-settings-durability-contract` on branch
  `sb10-settings-durability-contract`. It changes only the Contract 10 audit
  draft, `settings-persistence.test.ts`, and `settings-command.test.ts`.
  Focused verification passed 2 files / 28 green tests with 2 retained public
  expected failures. R10.1 proves that `/settings` emits an unqualified success
  message after a real file-persisting `SettingsService` fails replacement while
  a fresh service still sees the predecessor; R10.2 proves a direct credential
  leaf is rendered by `/settings`. The ordinary form of each red failed before
  restoration to `it.fails`. Lock language is deliberately limited to fresh
  mtime within its timeout and stale-mtime reclamation by policy, not holder
  liveness. Typecheck, Prettier, tracked and untracked diff checks, and final
  independent review passed. No production repair, commit, or merge is
  authorized.
- **Contract 10 owner decisions before repair:** durable-settlement API versus
  runtime-only notification, direct credential-display redaction/reveal policy,
  credential-at-rest policy, corruption recovery, and selected-provider
  normalization. The D5/D8/D10 designations are Contract 11 decisions, not
  Contract 10: the C11 v2 decision cycle is terminally complete and the record
  landed tests/docs-only (see `docs/contracts/11-destructive-approval-authority.md`).
  Contract 10 credential-at-rest and direct credential-display policies remain
  escalated to the President (secrets decisions).
- **Reviewed disposition — SB-08 hooks (tracker-only):** retain
  `HookService` as the narrow local `HookLifecyclePort` for lifecycle owners;
  its discovery, loading, registry, timeout, and diagnostic policy remain
  encapsulated. The versioned V1 external hook protocol is already an earned
  formal public contract in `docs/public-hooks.md` and the completed
  `public-hooks-system.md`, with package-boundary acceptance coverage. The
  coordinator independently ran the focused hooks suite: 8 files / 33 green
  tests. No new contract record, worktree, public red, or production repair is
  warranted. Retain only owner decisions for handle-owned non-interactive
  session-lifecycle fallback and whether shutdown must drain already-started
  fire-and-forget dispatches before clearing the registry.
- **Reviewed implementation awaiting owner decisions/integration:** Contract 12
  queue persistence/recovery in
  `.worktrees/queue-persistence-recovery-contract` on branch
  `queue-persistence-recovery-contract`. It changes only three test files and
  the Contract 12 audit draft. Focused verification passed 3 files / 92 green
  tests with one expected R1 failure; typecheck, Prettier, and diff checks
  passed. R1 was first observed as ordinary `it`: an interrupted active record
  with no retained queue reports `paused/recovered_interrupted` instead of
  `idle`, then was restored to `it.fails`. C12.5 is deliberately narrow: the
  recovered reserved non-text placeholder is not passed to `turnFlow.start` and
  pauses only when another retained item exists. Observer ordering, lone-marker
  settlement, and marker/text collision are residual owner decisions, not reds
  or defects. No production repair, commit, or merge is authorized.
- **Reviewed implementation — memory C3.7 landed docs-only, characterizations unmerged:** SB-08
  persistent-memory disposition in
  `.worktrees/sb08-memory-local-disposition` on branch
  `sb08-memory-local-disposition`. It adds two green `FileMemoryStore`
  public-boundary characterizations and a child-capability characterization;
  its audit record correctly retains persistent memory as a local interface and
  proposes the Contract 03 child-authority extension. The extension landed
  docs-only 2026-08-16 as **C3.7** in
  `docs/contracts/03-child-run-identity-authority-and-lifecycle.md`; the two
  `FileMemoryStore` characterizations and the stricter strict-subset
  characterization remain unmerged in this worktree (separately authorized). It
  creates no Contract 10 memory record and changes no production source.
- **SB-08 memory verification:** the coordinator independently ran all
  non-Git gates with `pnpm --dir
  /home/qduc/term2/.worktrees/sb08-memory-local-disposition`: focused
  `NODE_ENV=test` passed 3 files / 44 tests; typecheck, Prettier, and diff check
  passed. The implementer's full suite recorded 6,236 passed, 1 known
  settings-schema baseline failure, and 2 skips. An independent Luna review
  confirmed public boundaries, temp-root cleanup, local-disposition scope, and
  no Contract 10 collision; its ambient-memory read concern was corrected by
  using one isolated temporary `memory.directory` for both capability builders.
- **Reviewed implementation — Contract 09 record landed docs-only, characterizations unmerged:** SB-08
  workspace authority Contract 09 in `.worktrees/sb08-workspace-authority` on
  branch `sb08-workspace-authority`. Its audit-draft record landed docs-only
  2026-08-16 as `docs/contracts/09-execution-root-authority-and-workspace-lease.md`
  (slice I); the three green public-boundary characterizations (completion
  cache G2, sandbox allowlist G5, and path classification G6) remain unmerged
  in this worktree and are recorded as classified coverage gaps in the landed
  record; no production source, commit, or merge changed.
- **SB-08 workspace verification:** the coordinator independently ran all
  non-Git gates with `pnpm --dir
  /home/qduc/term2/.worktrees/sb08-workspace-authority`: focused `NODE_ENV=test`
  passed 8 files / 101 tests; typecheck, Prettier, and diff check passed. The
  broader suite reported the known settings-schema baseline (and one transient
  unrelated Ink failure on its first attempt); it is not a clean full-suite
  result. Independent reviews corrected the source-audit inventory to include
  `StatusBar`, added the actual worktree-tool coupling to the matrix/gate, and
  made G6 distinguish active-root fallback from `process.cwd()` by leasing a
  sibling outside the current worktree and outside `/tmp`; final review PASS.
- **Reviewed implementation awaiting owner decisions/integration:** SB-08
  provider-cache coherence retained-red packet in
  `.worktrees/sb08-provider-cache` on branch `sb08-provider-cache`. Its one
  public `useModelSelection` proof shows a same-ID custom-provider update leaves
  the global provider-keyed model cache stale; the audit proposes a Contract 04
  extension but does not edit or claim existing Contract 04 ownership.
- **SB-08 provider-cache verification:** the coordinator independently ran all
  non-Git gates with `pnpm --dir
  /home/qduc/term2/.worktrees/sb08-provider-cache`: focused `NODE_ENV=test`
  passed 4 files / 71 tests with 1 expected failure; typecheck, Prettier, and
  diff check passed. The ordinary proof first observed `{ fetchCount: 1,
  modelIds: ['model-a'] }` against the required post-change `{ fetchCount: 2,
  modelIds: ['model-b'] }`, then was restored to `it.fails.sequential`.
  Independent review required and confirmed global provider unregistration and
  cache cleanup in `finally`; final review PASS. Provider black-box is not
  required for this hook-test/audit-only diff. Full suite retained only the
  known settings-schema baseline plus this expected failure.
- **Reviewed implementation awaiting owner decision:** SB-08 RTK shell-boundary
  packet in `.worktrees/sb08-rtk-boundary` on branch `sb08-rtk-boundary`. It
  adds only injected post-approval `shell.execute` characterizations and an
  audit note; it deliberately leaves Contract 05 extension versus local RTK
  ownership unresolved, changes no production source or contract record, and
  adds no retained product red.
- **SB-08 RTK verification:** the coordinator independently ran all non-Git
  gates with `pnpm --dir /home/qduc/term2/.worktrees/sb08-rtk-boundary`:
  focused `NODE_ENV=test` passed 2 files / 126 tests; typecheck, Prettier, and
  diff check passed. The full suite retained only the known settings-schema
  baseline. Independent review confirmed genuine injected public seams, literal
  eligible/ineligible/partial-chain/null/SSH/rejection assertions, no external
  side effects, post-approval wording, and the unresolved ownership record;
  final review PASS. Provider black-box is not required for this tests/docs-only
  diff.
- **First workflow-tooling follow-up (accepted, unmerged):**
  `.worktrees/candidate-gates-tooling` contains only
  `scripts/candidate-gates.ts` and `scripts/candidate-gates.test.ts`. It
  deterministically verifies registered primary/candidate worktrees, branch/base,
  staged/unstaged/untracked touch sets, exact/prefix scope, safe generic
  test/typecheck/format gates through explicit worktree scope, bounded UTF-8 and
  machine-readable evidence/output, and brief headings. Manager gates passed 25
  focused tests, script typecheck, Prettier, tracked and untracked diff checks,
  and an actual JSON CLI smoke. Two independent Pi/Luna reviews drove corrections;
  the final settled review returned PASS. It is coordination tooling only, with
  no production change, commit, merge, or authorization for either.
- **Execution-pool policy (President, 2026-08-15):** DeepSeek, Luna, and agy
  are preferred high-runway execution pools for bounded implementation, test
  generation, inventory, and deterministic validation—not emergency-only
  fallback. Before every dispatch, verify the exact model, billing account/pool,
  and current context; DeepSeek stays below its 300k-token soft ceiling. Keep
  one writer per candidate and apply normal scoped gates. Terra remains the
  owner for management, owner semantics, complex/security seams, and
  acceptance.
- **Manager-owned external-team pane ledger (2026-08-15):** settled, harvested
  inherited sessions were collected without reset or focus changes into the
  dedicated `w3` workspace: `w3:p2` Claude — SB-08 inventory (idle); `w3:p3`
  agy — SB-02 review (idle, quota exhausted); `w3:p5` Pi — SB-08 RTK (fresh
  session, idle); and `w3:p6` Pi — SB-08 provider cache (done). Grok's settled
  settings review was harvested, then its old `w3:p4` pane was standalone-reset
  and transferred non-focused to agent-channel manager ownership as `w4:p2`
  (Grok 4.6 medium; 49% weekly quota remaining; zero model calls in the fresh
  session). The Pi sessions are a separate constrained Luna-only pool, not the
  root/Terra weekly quota: check their own quota and context before bounded
  routine dispatches and never upgrade their model. Former `w1` pane IDs are
  retired after collection moves. Reuse requires a new-task reset and visible
  ready-state verification; no session may be closed unless this manager
  created it.
- **Open audit drafts:**
  - SB-00 — **CLOSED** (2026-08-15). The closure-audit findings (94-vs-96 count
    delta, 19-cluster disposition completeness, nonexistent export-owner names,
    unreliable source ranges, three misclassified local interfaces, and the
    four earned direct unit-test gaps) are resolved and verified in the close
    record `service-boundary-contract-completion-sb00-close-record.md` (in
    `.worktrees/sb00-close-record`). The four gap suites were merged to local
    `main` under President grant `sb00-land-accepted`: 25 focused tests green
    (5 + 8 + 8 + 4).
  - SB-01 — `TurnWorkflow` outcome typing, closed union drafting, and dead continuation declaration analysis.
  - SB-04 — `ConversationService` 57-member facade mapping and `SessionRuntime` boundary audit.
  - SB-08 — peripheral service family dispositions (deletion and two-adapter test evaluations for all 9 families).
- **Reviewed drafts:** SB-02 Contract 08, SB-03 local capability disposition,
  SB-05 Contract 07, SB-06 Contract 06,
  and the SB-07 Contract 02 C2.6 extension, with their
  worktrees, gates, retained red proofs, and owner decisions recorded above.
- **Authorized changes:** the coordinator may update this plan. The `agy`
  implementer or another coordinator-assigned external implementer may create
  one dedicated worktree per remaining SB workstream and change contract
  records and tests there after a self-contained coordinator brief. Claude and
  Grok are read-only reviewers. Production source, configuration, and fixtures
  remain unchanged; no commit, merge, or push is authorized yet. **Superseded
  for SB-00 only by President grant `sb00-land-accepted` (2026-08-15):** the
  four accepted gap test worktrees were merged to local `main` and the SB-00
  row was closed; no push was performed.
- **Rules before implementation:** Every defect candidate must have an exact public-boundary red characterization test in a dedicated worktree before code repair.

## Goal

Audit every meaningful service seam and give it an evidence-backed disposition without creating ports merely because a module is exported:

- **formal contract** for cross-owner lifecycle, authority, persistence, transport, or destructive-effect seams;
- **local interface is sufficient** for cohesive modules whose behavior is already owned and tested through one surface; or
- **not a seam** for implementation helpers that do not vary independently.

This tracker authorizes read-only inspection and audit-document updates, not implementation. A proposed type change, test, or production repair becomes a separately authorized follow-up only after synthesis and owner review.

## Contract standard

For a seam that appears to require a formal contract, audit and draft against the existing record structure from `docs/contracts/README.md`:

1. observable invariant and user-visible harm;
2. enforcement and recovery owners;
3. every execution path sharing the invariant;
4. identities and state crossing the seam;
5. success, failure, cancellation, retry, and ambiguous settlement;
6. diagnostic events or logs;
7. public interface under test;
8. deterministic matrix with exact test evidence;
9. focused and broader verification commands; and
10. classified gaps and residual hypotheses.

Use a separate `docs/contracts/NN-*.md` draft only when this full structure is earned. Mark new records as audit drafts until owner review. Otherwise record the local-interface or not-a-seam disposition in this plan, with its source and test evidence.

## Ordered tracker

| ID | Seam | Status | Completion criterion | Disposition |
| --- | --- | --- | --- | --- |
| SB-00 | Service-cluster & root-module inventory | closed | All production clusters (19/19, 180 files) and root `source/services/*.ts` modules (28/28) map to an existing contract, local-interface disposition, or not-a-seam rationale with verified source/test citations; the 94-vs-96 count delta is reconciled; the four earned direct unit-test gaps are landed on main. | Close record `service-boundary-contract-completion-sb00-close-record.md` (in `.worktrees/sb00-close-record`); 25 focused tests merged via `sb00-gap-{1..4}` |
| SB-01 | `TurnWorkflow` outcome and continuation types | reviewed; awaiting owner | The current outcome/plan shapes and unchecked `any` inventory are documented; five green public-boundary characterizations protect modeled outcomes, continuation forwarding, and hook identity, while B1 is a retained reachable settlement red. | Contract 01 extension plus 12-file / 345-green focused gate in `sb01-turn-outcome-contract-tests` |
| SB-02 | Conversation persistence and input-history durability | reviewed; awaiting owner | Current load, corruption, context mismatch, lock, write/fork, deletion, migration, and history behavior is captured in a reviewed draft matrix; five repair-sensitive gaps are retained red proofs without crash-durability overclaims. | Draft Contract 08 plus 159 focused tests in `sb02-conversation-durability-contract` |
| SB-03 | `ConversationAgentClient` capability composition | reviewed; awaiting owner | The 38-member composite, production adapter, dynamic capability sites, absence settlements, two live type gaps, and dead lookup/declaration are inventoried; 13 tests protect the live consumer behavior. | Local role interfaces sufficient / retained composite facade; 102 focused tests in `sb03-conversation-agent-client-capability` |
| SB-04 | `ConversationService` facade and `SessionRuntime` exposure | reviewed; awaiting owner | The 57-member facade and 16-member closed runtime surface are characterized through public construction, delegation, reset, and opacity boundaries; two reset attachment defects remain retained reds. | Local compatibility facade / later runtime port hardening; 96-green focused gate in `sb04-facade-characterization` |
| SB-05 | Logging and provider-traffic ports | reviewed; awaiting owner | Accepted metadata, response variants, write-failure behavior, redaction, observability, boundary-level `any`, and schema enforcement are mapped with verified test citations. | Draft Contract 07 plus 89 focused tests in `sb05-logging-contract-tests` |
| SB-06 | SSH transport lifecycle | reviewed; awaiting owner | Current connect/disconnect/`executeCommand` behavior, timeout/cancellation gaps, command wrapping, error outcomes, consumers, and test coverage form a draft lifecycle matrix. | Draft Contract 06 plus 47 public-boundary tests in `sb06-ssh-contract-tests` |
| SB-07 | Provider registry fetch and unary response types | reviewed; awaiting owner | Adapter opaque-lane ownership, unary behavior, retry decoration, catalog fetch typing, provider implementations, and black-box coverage are inventoried; three missing green public-boundary proofs now protect C2.6. | Reviewed Contract 02 C2.6 extension plus 170 focused tests in `sb07-c26-adapter-isolation` |
| SB-08 | Peripheral service disposition | closed | Handoff, model/provider management, file/workspace discovery, skills, notifications, cost, memory, RTK, and local shell sessions each have deletion/two-adapter evaluations and verified test citations. | Dispositions recorded; memory C3.7 + Contract 09 landed docs-only 2026-08-16 (slice I); hooks disposition tracker-only; RTK/provider-cache packets landed; G2/G5/G6 + memory strict-subset characterizations unmerged (separately authorized) |

---

## Named Root-Module & Cluster Ledger (SB-00)

### First-level cluster reconciliation (2026-08-15)

The former closure claim of "8 of 19 production clusters / 97 production files"
was mechanically overstated: `test-helpers/` is non-production and nested helper
paths inflate the `*.test.ts`-excluded total. The honest remainder is seven
production clusters, 94 implementation files, whose **SB-00 mapping** was absent;
this is not evidence that no governing contract exists elsewhere.

| Cluster | Implementation files | Evidence-backed SB-00 disposition |
| --- | ---: | --- |
| `agent-runtime/` | 28 | Existing formal coverage: Contract 01 names `ApplicationRunLoop` (`application-run-loop.ts:337`; Contract 01:17-24); run-budget/guard portions are Contract 05. Explicit cluster mapping is now recorded; residual inventory remains deferred. |
| `approval/` | 18 | Partial formal coverage: `ToolApprovalBatchCoordinator` (`tool-approval-batch-coordinator.ts:56`) participates in Contracts 01/05; destructive approval authority remains the provisional Contract 11 owner decision, not an SB-00 closure claim. |
| `subagents/` | 17 | Formal Contract 03 coverage: `SubagentManager` (`subagent-manager.ts:34`) and strategy runners/authority lifecycle (Contract 03:4-6,22-28). |
| `settings/` | 11 | Formal Contract 04 coverage: `SettingsService` (`settings-service.ts:92`); persistence/migration/sensitive bytes remain provisional Contract 10 owner decisions. |
| `hooks/` | 10 | V1 public-hooks protocol is an existing formal contract (`docs/public-hooks.md`; `public-hooks-system.md` completion); `HookService` (`hook-service.ts:46`) remains the sufficient narrow local lifecycle port. Residual owner decisions: non-interactive handle fallback and shutdown draining. |
| `retry/` | 9 | Existing formal coverage: `DefaultRecoveryExecutor` (`recovery-executor.ts:23`) is named by Contract 05:35; retry continuity also meets Contract 02. |
| `queue/` | 1 | Formal Contract 01 coverage: `QueueController` (`queue-controller.ts:286`; Contract 01:17-24); persistence/recovery extension is reviewed Contract 12, awaiting owner integration. |
| `test-helpers/` | 1 | Explicitly out of scope: `mock-stream.ts` is a test fixture, not production service behavior. |

### Root `source/services/*.ts` Modules

| File | Primary Owner / Export | Seam Classification | Evidence & Rationale |
| --- | --- | --- | --- |
| `agent-stream.ts` | `AgentStream` wrapper | **Local interface is sufficient** | Wraps async iterable events, aggregates chunks, and dispatches to listeners. Source evidence: `source/services/agent-stream.ts:1-68`. Verified test: `source/services/agent-stream.test.ts:5` (`it('unwraps item events and keeps unknown provider entries')`), `source/services/agent-stream.test.ts:18` (`it('drops run_budget events alongside the other non-history events')`). |
| `background-task-activity.ts` | `BackgroundTaskActivity` | **Contract 03 / 05** | Formats background subagent and shell task activity. Source evidence: `source/services/background-task-activity.ts:1-60`. Verified test: `source/services/background-task-activity.test.ts:9` (`it('clamps clock skew and uses the executor threshold')`), `source/services/background-task-activity.test.ts:20` (`it('preserves ordinary names while bounding and neutralizing terminal controls')`). |
| `command-message-streaming.ts` | `extractCommandMessages` | **Local interface is sufficient** | Extracts command messages from stream events. Source evidence: `source/services/command-message-streaming.ts:1-75`. Verified test: `source/services/command-message-streaming.test.ts:8` (`it('captureToolCallArguments: stores args for function_call rawItem')`), `source/services/command-message-streaming.test.ts:41` (`it('emitCommandMessagesFromItems: attaches args and filters duplicates/rejections')`). |
| `conversation-agent-client.ts` | `ConversationAgentClient` | **SB-03** | Core client interface declaring 38 total methods (35 own + 3 chat); subject to SB-03 capability partitioning. Source evidence: `source/services/conversation-agent-client.ts:59-63, 84-148`. |
| `execution-context.ts` | `ExecutionContext` | **Contract 05 & SB-06** | Manages execution root leasing and remote SSH directory authority. Source evidence: `source/services/execution-context.ts:17-87`. Verified test: `source/services/execution-context.test.ts:47` (`it('getCwd returns process.cwd when not remote')`), `source/services/execution-context.test.ts:104` (`it('rejects entering a local workspace in remote mode, where the remote dir owns the root')`). |
| `file-service.ts` | `scanWorkspaceEntries` | **Local interface is sufficient** | Workspace directory traversal with depth (25) and entry (10,000) caps. Source evidence: `source/services/file-service.ts:1-65`. Verified test: `source/services/file-service.test.ts:7` (`it('scanWorkspaceEntries prioritizes breadth over depth when capped')`). |
| `generation-guard.ts` | `GenerationGuard` | **Contract 05** | Guards turn generation tokens against concurrent race conditions. Source evidence: `source/services/generation-guard.ts:1-55`. Verified test: `source/services/generation-guard.test.ts:8` (`it('capture returns a token and increments generation')`), `source/services/generation-guard.test.ts:118` (`it('integration - undo during active stream work prevents mutation and aborts turn')`). |
| `history-service.ts` | `HistoryService` | **SB-02** | Manages composer prompt history persistence. Source evidence: `source/services/history-service.ts:1-120`. Verified test: `source/services/history-service.test.ts:37` (`it('addMessage() stores multimodal turns and persists them')`). Non-atomic write is a coverage gap / residual hypothesis. |
| `input-surge-guard.ts` | `InputSurgeGuard` | **Contract 05** | Detects high-frequency user input surges and applies throttling. Source evidence: `source/services/input-surge-guard.ts:1-98`. Verified test: `source/services/input-surge-guard.test.ts:104` (`it('InputSurgeGuard allows abrupt message-count growth from last successful input')`), `source/services/input-surge-guard.test.ts:131` (`it('InputSurgeGuard blocks replayed tool-call signatures')`). |
| `interruption-info.ts` | `InterruptionInfo` | **Contract 01 / 05** | Formats turn interruption metadata and dynamic function extraction. Source evidence: `source/services/interruption-info.ts:1-95`. Verified test: `source/services/interruption-info.test.ts:26` (`it('getMethod returns callable function or null')`), `source/services/interruption-info.test.ts:103` (`it('getToolInfoFromInterruption reads function-tool shape')`). |
| `large-uncached-input-guard.ts` | `LargeUncachedInputGuard` | **Contract 05** | Estimates uncached prompt tokens and issues warnings. Source evidence: `source/services/large-uncached-input-guard.ts:1-135`. Verified test: `source/services/large-uncached-input-guard.test.ts:6` (`it('warns above threshold after provider, model, or reasoning changes')`). |
| `mode-notices.ts` | `formatModeNotice` | **Not a seam** | Pure string formatting helper for terminal mode change notices. Source evidence: `source/services/mode-notices.ts:1-25`. No dedicated test file; unit-tested indirectly through conversation state rendering. |
| `model-service.ts` | `fetchModels`, `clearModelCache` | **Local interface is sufficient** | Fetches model lists and manages in-memory caching. Source evidence: `source/services/model-service.ts:1-110`. Verified test: `source/services/model-service.test.ts:16` (`it.sequential('fetchModels uses OpenRouter endpoint and caches results')`), `source/services/model-service.test.ts:77` (`it.sequential('fetchModels uses OpenAI models endpoint when provider is openai')`). |
| `notification-service.ts` | `sendNotification` | **Not a seam** | Stateless terminal escape sequence formatter (OSC 777, OSC 9, BEL). Source evidence: `source/services/notification-service.ts:1-110`. Verified test: `source/services/notification-service.test.ts:27` (`it('supportsOsc777 recognizes supported terminals')`), `source/services/notification-service.test.ts:88` (`it('notify writes OSC 777 for capable terminals and sanitizes payloads')`). |
| `openai-candidate-observer.ts` | `OpenAICandidateObserver` | **Contract 01 / 02** | Observes candidate responses across stream retries. Source evidence: `source/services/openai-candidate-observer.ts:1-60`. Verified test: `source/services/openai-candidate-observer.test.ts:19` (`it('creates a candidate only for a terminal OpenAI observation with an exact bound response')`). |
| `openai-root-checkpoint-lifecycle-observer.ts` | `OpenAIRootCheckpointLifecycleObserver` | **Contract 02** | Observes OpenAI server-side compaction checkpoint lifecycle. Source evidence: `source/services/openai-root-checkpoint-lifecycle-observer.ts:21-67`. Verified test: `source/services/openai-root-checkpoint-lifecycle-observer.test.ts:4` (`it('records frozen sanitized lifecycle evidence')`). |
| `openai-root-provider-identity.ts` | `isOpenAIRootProvider` | **Not a seam** | Pure provider string matching utility. Source evidence: `source/services/openai-root-provider-identity.ts:1-12`. Tested indirectly through root observer suites. |
| `openai-root-selector-parity-observer.ts` | `OpenAIRootSelectorParityObserver` | **Contract 01 / 02** | Validates selector parity during initial stream retries. Source evidence: `source/services/openai-root-selector-parity-observer.ts:1-85`. Verified test: `source/services/openai-root-selector-parity-observer.test.ts:27` (`it('records equality only for an eligible accepted OpenAI checkpoint')`). |
| `plan-mode-interceptor.ts` | `createPlanModeInterceptor` | **Local interface is sufficient** | Intercepts tool calls in plan mode. Source evidence: `source/services/plan-mode-interceptor.ts:1-40`. Verified test: `source/services/plan-mode-interceptor.test.ts:4` (`it('installPlanModeInterceptor rejects mutating tools when planMode is true')`). |
| `provider-continuity.ts` | `ProviderContinuity` | **Contract 02** | Tracks upstream response IDs and chain settlement. Source evidence: `source/services/provider-continuity.ts:1-210`. Verified test: `source/services/provider-continuity.test.ts:4` (`it('initial state is clear')`), `source/services/provider-continuity.test.ts:82` (`it('keeps a candidate checkpoint separate from existing previousResponseId behavior until terminal acceptance')`). |
| `rtk-service.ts` | `ensureRtkInstalled`, `wrapWithRtk` | **SB-08 (Local interface sufficient / External-effect)** | Downloads binaries, verifies SHA-256 checksums, extracts tarballs, and rewrites AST commands. Source evidence: `source/services/rtk-service.ts:148-259`. Verified test: `source/services/rtk-service.test.ts:156` (`it('wrapWithRtk prefixes a single command with quoted rtkPath')`), `source/services/rtk-service.test.ts:207` (`it.sequential('ensureRtkInstalled returns path when binary already exists')`), `source/services/rtk-service.test.ts:296` (`it.sequential('ensureRtkInstalled returns null and does not install when checksum does not match')`), `source/services/rtk-service.test.ts:321` (`it.sequential('ensureRtkInstalled returns binary path on successful install')`). |
| `runtime-setting-router.ts` | `RuntimeSettingRouter` | **Contract 04** | Dispatches runtime setting changes to session controllers. Source evidence: `source/services/runtime-setting-router.ts:1-45`. Verified test: `source/services/runtime-setting-router.test.ts:25` (`it('applies all runtime changes through one settings transaction before runtime effects')`). |
| `service-interfaces.ts` | Port interface definitions | **SB-05 / SB-06** | Defines `ILoggingService`, `ISSHService`, and `IProviderTraffic`. Source evidence: `source/services/service-interfaces.ts:1-139`. Type declarations only. |
| `ssh-service.ts` | `SSHService` | **SB-06 (Formal contract draft)** | Manages remote SSH connection lifecycle and `executeCommand`. Source evidence: `source/services/ssh-service.ts:14-150`. Verified test: `source/services/ssh-service.test.ts:66` (`it('connect: establishes connection successfully')`), `source/services/ssh-service.test.ts:140` (`it('executeCommand: executes command and returns result')`). |
| `stream-event-processor.ts` | `StreamEventProcessor` | **Local interface is sufficient** | Processes streaming tokens and updates turn accumulator. Source evidence: `source/services/stream-event-processor.ts:1-350`. Verified test: `source/services/stream-event-processor.test.ts:45` (`it('emits text_delta events with accumulated fullText')`), `source/services/stream-event-processor.test.ts:189` (`it('emits tool_started for a native function_call item')`). |
| `stream-snapshot.ts` | `StreamSnapshot` | **Not a seam** | Value types for immutable stream state snapshots. Source evidence: `source/services/stream-snapshot.ts:1-35`. Type definitions only. |
| `tool-call-arguments.ts` | `parseToolCallArguments` | **Not a seam** | Pure JSON parsing helper for tool arguments. Source evidence: `source/services/tool-call-arguments.ts:1-25`. Tested indirectly through stream processing and replay. |
| `tool-execution-ledger.ts` | `ToolExecutionLedger` | **Contract 02 / 05** | Reconciles uncommitted tool executions against streaming journals. Source evidence: `source/services/tool-execution-ledger.ts:1-290`. Verified test: `source/services/tool-execution-ledger.test.ts:11` (`it('ToolExecutionLedger records completed function call pairs')`), `source/services/tool-execution-ledger.test.ts:733` (`it('settleOpenCallsOnStreamFailure splits never-dispatched aborted from dispatched unknown')`). |

---

## Detailed Workstream Audit Records

### SB-01 — `TurnWorkflow` Outcome and Continuation Types
- **Owner:** `TurnWorkflow` (`source/services/session/turn-workflow.ts`), `buildConversationResult` (`source/services/conversation/conversation-result-builder.ts`), `TurnCoordinator` (`source/services/session/turn-coordinator.ts`).
- **Disposition:** **Local interface is sufficient (closed unions).**
- **Observable Outcomes Inventory:**
  1. *Public Turn Outcomes (`TurnOutcome` in `source/services/session/turn-status-machine.ts:5-9`):*
     - `{ kind: 'response', terminal: ConversationTerminal }`
     - `{ kind: 'approval_required', terminal: ConversationTerminal }`
     - `{ kind: 'stale' }`
     - `{ kind: 'failed' }`
  2. *Internal Workflow Re-entry Outcomes (`InternalTurnOutcome` in `source/services/session/turn-workflow.ts:22-39`):*
     - All 4 `TurnOutcome` variants plus:
     - `{ kind: 'fresh_start_required', retryCounts: RetryCounts, delayMs?: number, useStandardServiceTier?: boolean }`
     - `{ kind: 'abort_resolution_required', abortedContext: AbortedApprovalContext, userText: string, generation: number }`
     - `{ kind: 'auto_approval_required', generation: number, callId?: string, command?: string }`
  3. *Stream Result Outcomes (`BuildResultOutcome` in `source/services/conversation/conversation-result-builder.ts:34-42`):*
     - `{ kind: 'response', result: Extract<ConversationTerminal, { type: 'response' }> }`
     - `{ kind: 'approval_required', result: Extract<ConversationTerminal, { type: 'approval_required' }> }`
     - `{ kind: 'auto_approve', advisory?: LLMAdvisory, callId: string | undefined, argumentsText: string }`
- **Trace of `any` Occurrences & Dead Declarations:**
  - `turn-workflow.ts:112`: `#liveRun: LiveRun<..., { kind: 'completed'; outcome: any } | ...>` $\to$ maps to `BuildResultOutcome`.
  - `turn-workflow.ts:499, 578, 967, 1066`: `outcome: any` $\to$ maps to `BuildResultOutcome`.
  - `turn-workflow.ts:720, 763, 1074`: `resumeOptions: any`, `startOptions: any`, `continuationOptions: any` $\to$ maps to `AgentClientRunOptions` (`conversation-agent-client.ts:19-37`).
  - `turn-workflow.ts:974`: `nextPlan: any` $\to$ maps to `ContinuationPlan` (`approval-flow-coordinator.ts:39-42`).
  - `turn-workflow.ts:975`: `{ action: 'continue' }` is declared in `#handleApprovalOutcome` return union but never produced by any branch (**dead code declaration**).
- **Exact Verified Test Evidence:**
  - `source/services/session/turn-workflow.test.ts:59`: `it('executes initial turn successfully')`
  - `source/services/session/turn-workflow.test.ts:646`: `it('executeInitial resolves aborted approvals through continuation')`
  - `source/services/session/turn-workflow.test.ts:685`: `it('executeInitial auto-approves shell approvals')`
  - `source/services/session/turn-workflow.test.ts:722`: `it('executeInitial redrives initial execution when continuation requests a fresh start')`
  - `source/services/session/turn-workflow.test.ts:785`: `it('executeContinuation redrives initial execution when recovery requests a fresh start')`
  - `source/services/session/turn-workflow.call-ids.test.ts:210`: `it('keeps rejected and approved sibling ids during abort resolution')`
  - `source/services/session/turn-coordinator.test.ts:177`: `it('streaming -> awaiting_approval')`
  - `source/services/session/turn-coordinator.test.ts:296`: `it('Terminal completion to idle')`
  - `source/services/session/turn-coordinator.test.ts:309`: `it('failed completes the status and emits an authoritative error instead of ending silently')`
  - `source/services/session/turn-coordinator.test.ts:338`: `it('stale leaves status untouched because lifecycle operation resolved it')`
  - `source/services/conversation/conversation-result-builder.test.ts:179`: `it('response outcome when stream has no interruptions')`
  - `source/services/conversation/conversation-result-builder.test.ts:305`: `it('approval_required outcome when stream has interruptions')`
  - `source/services/conversation/conversation-result-builder.test.ts:327`: `it('auto_approve outcome for valid read-only interruptions registered with the policy registry')`

---

### SB-02 — Conversation Persistence and Input-History Durability
- **Owner:** `conversation-persistence.ts`, `conversation-replay.ts`, `conversation-log-writer.ts`, `history-service.ts`.
- **Disposition:** **Formal Contract 08 draft planned.** Contract 08 owns durable
  local bytes, descriptors, lockfiles, atomic replacement, torn records,
  sidecars, deletion, migration, and composer history. Contract 02 retains the
  provider-facing meaning of faithfully replayed items; the records meet only
  at that save/resume handoff.

#### Durability & Recovery Matrix

| Scenario | Expected / Observed Outcome | Classification | Exact Source & Verified Test Evidence |
|---|---|---|---|
| **Absent Conversation** | `loadConversation` returns `null`. | Characterized & Tested | Source: `conversation-persistence.ts:250`. Verified test: `source/services/conversation/conversation-persistence.test.ts:182` (`it.sequential('loadConversation: returns null for missing id')`). |
| **Context Mismatch** | `loadConversationForProject` returns `{ status: 'project_mismatch' }`. | Characterized & Tested | Source: `conversation-persistence.ts:284`. Verified test: `source/services/conversation/conversation-persistence.test.ts:421` (`it.sequential('loadConversationForProject: reports project mismatch')`). |
| **Corrupt JSONL Record** | Malformed lines skipped by `decodeEnvelopeLines`; replay recovers valid envelopes. | Characterized & Tested | Source: `conversation-decoder.ts:51`. Verified test: `source/services/conversation/conversation-persistence.test.ts:148` (`it.sequential('loadConversation: skips malformed known event lines and continues replay')`). |
| **Torn Final Line** | `readLogTailState` detects missing `\n`, appends repair newline before `session_init`. | Characterized & Tested | Source: `conversation-log-writer.ts:121`. Verified test: `source/services/logging/conversation-log-writer.test.ts:196` (`it('continues sequence numbers when reopening a log with legacy and malformed trailing records')`). |
| **Locked Conversation** | Writer throws `LockConflictError`. | Characterized & Tested | Source: `conversation-log-writer.ts:244`. Verified test: `source/services/conversation/conversation-persistence.test.ts:277` (`it.sequential('lock: collision throws LockConflictError')`). |
| **Delta Sidecar Merge** | `readEnvelopes` merges `.jsonl` and `.deltas` by `seq` counter on `--resume`. | Characterized & Tested | Source: `conversation-persistence.ts:174`. Verified test: `source/services/conversation/conversation-persistence.test.ts:1367` (`it.sequential('delta sidecar: an interrupted turn replays identically to the legacy inline format')`), supplemented by `:1402` (`it.sequential('delta sidecar: a missing sidecar still loads the settled part of a conversation')`). |
| **Atomic Fork** | Writes to `.${newId}.${uuid}.tmp` with `flag: 'wx'`, atomic rename to destination. | Characterized & Tested | Source: `conversation-persistence.ts:501`. Verified test: `source/services/conversation/conversation-persistence.test.ts:297` (`it.sequential('forkConversation: immediately persists the fork identity, provenance, and source history')`). |
| **Atomic Last Session** | Writes `last.json.tmp` and renames to `last.json`. | Characterized & Tested | Source: `conversation-persistence.ts:580`. Verified test: `source/services/conversation/conversation-persistence.test.ts:677` (`it.sequential('loadLastConversation: falls back to scanning when no last.json entry matches')`). |
| **Raw Read Error Asymmetry** | `loadConversation` catches `fs` errors, but `loadConversationForProject` lets raw `fs` exceptions propagate. | **Coverage gap / defect hypothesis** | Source: `conversation-persistence.ts:249-265` (has try/catch) vs `:268-288` (lacks try/catch). Future proof required: public-boundary red characterization proving unhandled crash when unreadable/permission-denied file is loaded for a project. |
| **Direct History Save** | `HistoryService.save()` writes directly via `fs.writeFileSync` without temp-file atomic rename. | **Coverage gap / defect hypothesis** | Source: `history-service.ts:108`. Future proof required: red characterization test simulating mid-write process termination resulting in truncated `history.json`. |
| **Residual Delta on Deletion** | `deleteConversation` removes `.jsonl` and `.lock` but omits `.deltas`. | **Coverage gap** | Source: `conversation-persistence.ts:322-356`. Verified test: `source/services/conversation/conversation-persistence.test.ts:527` (`it.sequential('deleteConversation: removes the jsonl and clears last.json')`) verifies jsonl/last.json removal, leaving `.deltas` cleanup unverified. |
| **Stale Lock PID Check** | Lock files record PID/host, but `isConversationLocked` does not check OS PID liveness (`process.kill(pid, 0)`). | **Residual hypothesis** | Source: `conversation-persistence.ts:310-320`. Future proof required: test demonstrating false lock conflict after abnormal termination of writer on same host. |

---

### SB-03 — `ConversationAgentClient` Capability Composition
- **Owner:** `source/services/conversation-agent-client.ts`, `source/lib/agent-client.ts`, `source/services/session/session-client-factory.ts`.
- **Disposition:** **Local role interfaces are sufficient for current consumers;
  retain the composite facade; broader type partitioning is deferred.** This is
  a local TypeScript ownership boundary, not a formal contract or a new runtime
  controller.
- **Method Inventory Verification:**
  - `ConversationAgentClient` declares **35 own methods** (`conversation-agent-client.ts:84-148`) and inherits **3 chat methods** from `ShellAutoApprovalAgentClient` (`conversation-agent-client.ts:59-63`), totaling **38 methods**.
  - **32 methods are optional (`?`)**; only 6 methods are required (`chat`, `startStream`, `continueRunStream`, `abort`, `setModel`, `addToolInterceptor`).
- **Dynamic Capability & Duck-Typing Inventory (In Progress / Open Surface):**
  - *`getMethod` Lookups in Session Orchestration:*
    - `session-composition.ts:385`: `getMethod(agentClient, 'getNestedToolCompatibilityState')`
    - `session-composition.ts:404`: `getMethod(agentClient, 'setOnToolDispatch')` — *missing from `ConversationAgentClient` interface declaration!*
    - `session-composition.ts:438, 771`: `getMethod(agentClient, 'getProvider')`
    - `session-composition.ts:607`: `getMethod(agentClient, 'getStreamMaxRetries')`
    - `session-composition.ts:730, 731`: `getMethod(agentClient, 'cancelBackgroundRuns')`, `getMethod(agentClient, 'cancelBackgroundShellJobs')`
    - `session-composition.ts:734, 746`: `getMethod(agentClient, 'disposeBackgroundSubagents')`, `getMethod(agentClient, 'disposeBackgroundShellJobs')`
    - `session-continuity-reset.ts:48`: `getMethod(this.#agentClient, 'clearConversations')`
    - `session-input-planner.ts:177, 323`: `getMethod(this.#agentClient, 'supportsConversationChaining')`
    - `session-input-planner.ts:387`: `getMethod(this.#agentClient, 'getProvider')`
    - `session-manager.ts:123`: `getMethod(this.#agentClient, 'getProvider')`
    - `session-runtime-controller.ts:29, 38, 47`: `getMethod(this.#agentClient, 'setReasoningEffort')`, `setTemperature`, `setProvider`
    - `turn-workflow.ts:341, 470`: `getMethod(this.deps.agentClient, 'useStandardServiceTierForNextRequest')` — *missing from `ConversationAgentClient` interface declaration!*
  - *Direct `typeof fn === 'function'` Checks:*
    - `session-runtime-controller.ts:60-63`: `typeof this.#agentClient.setRetryCallback === 'function'`
    - `background-task-control.ts:288-292`: `typeof this.#client.getBackgroundSubagentStatus === 'function'`, `typeof this.#client.getBackgroundShellJob === 'function'`
  - *Optional-Chaining Capability Invocations (`?.`):*
    - `conversation-service.ts:314-318`: `this.#clientHandle.agentClient.cancelBackgroundRuns?.()`
    - `conversation-service.ts:428-430`: `this.#clientHandle.agentClient.grantRunBudgetExtension?.()`
  - *Status:* Dynamic capability checks and indirect access forms remain an open audit area across session modules; above citations document verified dynamic sites.
- **Candidate Interface Partitioning:**
  - `StreamExecutionPort`: `startStream`, `continueRunStream`, `abort`.
  - `TurnSteeringPort`: `openTurn`, `closeTurn`, `steer`, `retractSteer`, `editSteer`, `grantRunBudgetExtension`.
  - `ProviderConfigPort`: `setModel`, `setProvider`, `getProvider`, `supportsConversationChaining`, `setReasoningEffort`, `setTemperature`, `setRetryCallback`, `clearConversations`.
  - `BackgroundTaskControlClient`: (As declared in `source/services/session/background-task-control.ts:94-117`).
  - `SubagentEventSinkHost`: (As declared in `source/services/conversation-agent-client.ts:69-82`).
  - `ShellAutoApprovalAgentClient`: (As declared in `source/services/conversation-agent-client.ts:59-63`).
- **Exact Verified Test Evidence:**
  - `source/lib/openai-agent-client.public-methods.test.ts:319`: `it.sequential('setModel updates the internal model')`
  - `source/lib/openai-agent-client.public-methods.test.ts:337`: `it.sequential('getProvider returns current provider')`
  - `source/lib/openai-agent-client.public-methods.test.ts:346`: `it.sequential('setProvider updates provider and persists to settings')`
  - `source/lib/openai-agent-client.public-methods.test.ts:371`: `it.sequential('application-owned startStream forwards previousResponseId to the model')`
  - `source/lib/openai-agent-client.public-methods.test.ts:405`: `it.sequential('continueRunStream preserves canonical history when chaining')`
  - `source/lib/openai-agent-client.public-methods.test.ts:460`: `it.sequential('abort during an active startStream')`
  - `source/lib/agent-client.application-run-loop.test.ts:434`: `it('keeps a steer waiting across the approval pause it resumes through')`
  - `source/services/session/session-client-factory.test.ts:11`: `it('creates a distinct registry and access capability for each session, then clears both after disposal')`

- **Accepted consumer characterizations:**
  - Service-tier override presence, absence, and ordering:
    `turn-workflow.test.ts:112,147,179`.
  - Retry-callback optional setter presence/absence:
    `session-runtime-controller.test.ts:106,115`.
  - Provider-policy chaining fallback and explicit client disable:
    `session-input-planner.test.ts:28,41`.
  - Run-budget grant pass-through and unavailable fallback:
    `conversation-service.test.ts:1866,1885`.
  - Background stop/transfer capability absence remains distinct from
    `not_found`: `background-task-control.test.ts:343,362,384,402`.
  These are green behavior tests through the owning public classes. They do not
  assert TypeScript membership, preserve the dead retry lookup, or reach into
  the session's private tool tracker.

---

### SB-04 — `ConversationService` Facade and `SessionRuntime` Exposure
- **Owner:** `ConversationService` (`source/services/conversation/conversation-service.ts`), `SessionRuntime` (`source/services/session/session-composition.ts`).
- **Disposition:** **Facade wrapper (local) / `SessionRuntime` port hardening.**
- **Member Mapping Verification (51 Methods + 6 Getters = 57 Total):**

| Member | Kind | Category | Primary Delegation | Primary Callers | Verified Test Evidence / Coverage Gap |
|---|---|---|---|---|---|
| `backgroundSubagentNotifications` | Getter | Background | `#runtime.backgroundSubagentNotifications` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1703` (`it('exposes per-item background task controls without leaking the session runtime')`) |
| `backgroundSubagentTasks` | Getter | Background | `#runtime.backgroundSubagentTasks` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1703` (`it('exposes per-item background task controls without leaking the session runtime')`) |
| `backgroundTaskControl` | Getter | Background | `#runtime.backgroundTaskControl` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1703` (`it('exposes per-item background task controls without leaking the session runtime')`) |
| `backgroundSubagentApprovals` | Getter | Approval | `#runtime.backgroundSubagentApprovals` | `useConversation` | Coverage gap (exposed via runtime pending interaction getter without dedicated facade unit test) |
| `sessionId` | Getter | State | `#runtime.sessionId` | `app.tsx`, `cli.tsx` | `source/services/conversation/conversation-service.test.ts:1190` (`it('resetWithNewId() updates sessionId')`) |
| `hookEvents` | Getter | Hooks | `#clientHandle.hookEvents` | `cli.tsx:712` | Coverage gap (delegates to client handle hook observer without dedicated facade test) |
| `setEventSink(sink)` | Method | Turns | `#adapter.setEventSink(sink)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:771` (`it('forwards streamed events to a persistent event sink across approval continuation')`) |
| `setBackgroundSubagentNotificationObserver` | Method | Background | `#runtime.backgroundSubagentNotifications` | `useConversation` | Coverage gap (delegates to notification observer without dedicated facade test) |
| `setBackgroundSubagentTaskObserver` | Method | Background | `#runtime.backgroundSubagentTasks` | `useConversation` | Coverage gap (delegates to background task manager without dedicated facade test) |
| `shutdown()` | Method | Lifecycle | `#runtime.shutdown()`, `#clientHandle.dispose()` | `cli.tsx:849` | Coverage gap (lifecycle shutdown path called on SIGINT/exit) |
| `resetWithNewId(newId)` | Method | Lifecycle | Composite teardown + re-instantiation | `app.tsx:261` | `source/services/conversation/conversation-service.test.ts:1165` (`it('resetWithNewId() clears conversation state')`), `:1242` (`it('resetWithNewId() replaces and disposes the factory-owned client')`) |
| `setLogSink(sink)` | Method | Logging | `#runtime.logs.setLogSink(sink)` | `cli.tsx:784` | Coverage gap (delegates to session logging sink) |
| `getCurrentSnapshot()` | Method | State | `#runtime.state.getCurrentSnapshot()` | `useConversation` | Coverage gap (delegates to `#runtime.state`) |
| `undoLastUserTurn()` | Method | State | `#runtime.state.undoLastUserTurn()` | `useConversation` | Coverage gap (delegates to `#runtime.state`) |
| `listUserTurns()` | Method | State | `#runtime.state.listUserTurns()` | `useConversation` | Coverage gap (delegates to `#runtime.state`) |
| `listRewindTargets()` | Method | State | `#runtime.state.listRewindTargets()` | `app.tsx:454` | `source/services/conversation/conversation-service.test.ts:690` (`it('forwards an opaque rewind target through the session boundary')`) |
| `rewindToTarget(targetId)` | Method | State | `#runtime.state.rewindToTarget(targetId)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:690` (`it('forwards an opaque rewind target through the session boundary')`) |
| `undoNUserTurns(n)` | Method | State | `#runtime.state.undoNUserTurns(n)` | `useConversation` | Coverage gap (delegates to `#runtime.state`) |
| `peekLastToolOutput()` | Method | State | `#runtime.state.peekLastToolOutput()` | `useConversation` | Coverage gap (delegates to `#runtime.state`) |
| `setModel(model)` | Method | Settings | `#runtime.settings.setModel(model)` | `useConversationSettings` | `source/services/conversation/conversation-service.test.ts:1298` (`it('setModel() delegates to agent client')`) |
| `setReasoningEffort(effort)` | Method | Settings | `#runtime.settings.setReasoningEffort(effort)` | `useConversationSettings` | Coverage gap (delegates to settings controller) |
| `setTemperature(temp)` | Method | Settings | `#runtime.settings.setTemperature(temp)` | `useConversationSettings` | `source/services/conversation/conversation-service.test.ts:1315` (`it('setTemperature() delegates to agent client when supported')`) |
| `setProvider(provider)` | Method | Settings | `#runtime.settings.setProvider(provider)` | `useConversationSettings` | `source/services/conversation/conversation-service.test.ts:1405` (`it('switchProvider() after abort does not replay the abandoned tool turn in the next full-history request')`) |
| `switchProvider(provider)` | Method | Settings | `#runtime.settings.switchProvider(provider)` | `useConversationSettings` | `source/services/conversation/conversation-service.test.ts:1405` (`it('switchProvider() after abort does not replay the abandoned tool turn in the next full-history request')`) |
| `setRetryCallback(cb)` | Method | Settings | `#runtime.settings.setRetryCallback(cb)` | `useRuntimeSettingsRouter`| Coverage gap (delegates to `#runtime.settings`) |
| `addShellContext(historyText)` | Method | Turns/State | `#adapter.injectIntoActiveTurn` $\to$ `#runtime.state` | `useShellMode` | Coverage gap (injects shell context during turn) |
| `queueModeNotice(text)` | Method | State | `#runtime.state.queueModeNotice(text)` | `app.tsx` | Coverage gap (delegates to `#runtime.state`) |
| `abort()` | Method | Turns | `#adapter.abort()` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1332` (`it('abort() delegates to agent client and clears pending approval')`), `:1719` (`it('abort() aborts the turn without cancelling conversation-bound background runs')`) |
| `interruptFromUser()` | Method | Turns/Control | Multi-target cancel across adapter & client | `useConversation` | `source/services/conversation/conversation-service.test.ts:1754` (`it('interruptFromUser() aborts the turn and cancels conversation-bound background runs')`), `:1777` (`it('interruptFromUser() also cancels root background shell jobs')`) |
| `dispose()` | Method | Lifecycle | `#runtime.dispose()`, `#clientHandle.dispose()` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1284` (`it('does not dispose a caller-owned compatibility client during reset or service disposal')`) |
| `sendMessage(input, opts)` | Method | Turns | `#adapter.sendMessage(input, opts)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:102` (`it('queues foreground messages FIFO, returns each item terminal, and executes each input once')`) |
| `compactContext()` | Method | Compaction | `#runtime.compactContext()` + event synthesis | `app.tsx:509` | Coverage gap (manual context compaction orchestration) |
| `resumeQueue()` | Method | Queue | `#adapter.resumeQueue()` | `useConversation` | `source/services/conversation/conversation-service.test.ts:193` (`it('pauses queued foreground messages after a failed execution until resumeQueue is requested')`) |
| `discardQueue()` | Method | Queue | `#adapter.discardQueue()` | `useConversation` | Coverage gap (queue discard operation) |
| `retractSubmission(id)` | Method | Queue | `#adapter.retractSubmission(id)` | `useConversation` | Coverage gap (queue retraction operation) |
| `editSubmission(id, turn)` | Method | Queue | `#adapter.editSubmission(id, turn)` | `useConversation` | Coverage gap (queue edit operation) |
| `grantRunBudgetExtension()` | Method | Budget | `#clientHandle.agentClient.grantRunBudgetExtension()` | `useConversation` | Coverage gap (dynamic client call) |
| `getPendingInteractionSnapshot()` | Method | Approval | `#runtime.pendingInteraction.getSnapshot()` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1800` (`it('projects an adapter approval through the session-owned pending interaction facade')`) |
| `setPendingInteractionObserver` | Method | Approval | `#runtime.pendingInteraction.setObserver(obs)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1845` (`it('keeps the pending-interaction observer attached when the session is reset')`) |
| `resolvePendingInteraction(req)` | Method | Approval | `#runtime.pendingInteraction.resolve(req)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1800` (`it('projects an adapter approval through the session-owned pending interaction facade')`) |
| `presentPendingInteraction(appr)` | Method | Approval | `#runtime.pendingInteraction.present(appr)` | `useConversation` | Coverage gap (presents pending interaction to UI) |
| `clearPendingInteraction()` | Method | Approval | `#runtime.pendingInteraction.clear()` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1332` (`it('abort() delegates to agent client and clears pending approval')`) |
| `goToPreviousPendingInteractionQuestion` | Method | Approval | `#runtime.pendingInteraction.goToPreviousQuestion()` | `useConversation` | Coverage gap (multi-question navigation) |
| `goToNextPendingInteractionQuestion` | Method | Approval | `#runtime.pendingInteraction.goToNextQuestion()` | `useConversation` | Coverage gap (multi-question navigation) |
| `steerActiveTurn(input, opts)` | Method | Turns | `#adapter.steerActiveTurn(input, opts)` | `useConversation` | Coverage gap (mid-turn steering delegation) |
| `injectIntoActiveTurn(items)` | Method | Turns | `#adapter.injectIntoActiveTurn(items)` | `useConversation` | Coverage gap (mid-turn item injection) |
| `isQueueActive()` | Method | Queue | `#adapter.isQueueActive()` | `useConversation` | Coverage gap (queue query) |
| `isQueueOwningSubmissions()` | Method | Queue | `#adapter.isQueueOwningSubmissions()` | `useConversation` | Coverage gap (queue query) |
| `queueStateKind()` | Method | Queue | `#adapter.queueStateKind()` | `useConversation` | Coverage gap (queue query) |
| `setQueueStateObserver(obs)` | Method | Queue | `#adapter.setQueueStateObserver(obs)` | `useConversation` | Coverage gap (queue state observer) |
| `setQueuedTurnStartObserver(obs)` | Method | Queue | `#adapter.setQueuedTurnStartObserver(obs)` | `useConversation` | Coverage gap (queued turn start observer) |
| `retryLastToolOutput(opts)` | Method | Turns/State | Coord abort + state rollback + replay | `useConversation` | `source/services/conversation/conversation-service.test.ts:645` (`it('retryLastToolOutput trims trailing assistant text and replays full history')`) |
| `previewLargeUncachedInput` | Method | Guards | `#runtime.state.previewLargeUncachedInput(input, now)` | `app.tsx:354` | Coverage gap (guard preview on facade) |
| `previewInputSurge(input)` | Method | Guards | `#runtime.state.previewInputSurge(input)` | `useConversation` | Coverage gap (guard preview on facade) |
| `handleApprovalDecision` | Method | Approval | `#adapter.handleApprovalDecision(answer, reason, opts)` | `useConversation` | `source/services/conversation/conversation-service.test.ts:1458` (`it('handleApprovalDecision() rejects interruption when answer is n')`), `:1516` (`it('handleApprovalDecision() returns null when no pending approval')`) |
| `exportState()` | Method | Persistence | `#runtime.state.exportState()` | `cli.tsx` | Coverage gap (delegates to `#runtime.state.exportState()`) |
| `importState(state)` | Method | Persistence | `#runtime.state.importState(state)` | `cli.tsx:729` | Coverage gap (delegates to `#runtime.state.importState()`) |

---

### SB-05 — Logging and Provider-Traffic Ports
- **Owner:** `ILoggingService` (`source/services/service-interfaces.ts:13-22`), `IProviderTraffic` (`source/services/service-interfaces.ts:24-90`), `LoggingService` (`source/services/logging/logging-service.ts`), `ProviderTraffic` (`source/services/logging/provider-traffic.ts`).
- **Disposition:** **Reviewed Contract 07 draft.** The authoritative current
  contract, 66-row matrix, nine retained red proofs, and exact gate evidence are
  in `.worktrees/sb05-logging-contract-tests/docs/contracts/07-logging-and-provider-traffic.md`.
- **Transport & Redaction Characterization:**
  - **Instruction Truncation:** Limits system prompts and developer instruction text to 100 characters in logs (`provider-traffic.ts:217-260`). Verified tests:
    - `source/services/logging/provider-traffic.test.ts:21`: `it('sanitizeSentTrafficBody truncates instruction-like fields and preserves user/tool content')`
    - `source/services/logging/provider-traffic.test.ts:83`: `it('sanitizeSentTrafficBody truncates Responses Lite developer input_text instructions')`
    - `source/services/logging/provider-traffic.test.ts:103`: `it('sanitizeSentTrafficBody truncates system and developer messages in messages-style bodies only')`
    - `source/services/logging/provider-traffic.test.ts:147`: `it('sanitizeSentTrafficBody truncates anthropic message api system prompt (string or content array)')`
  - **Encrypted Payload Redaction:** Clears `encrypted_content` across request and response bodies (`provider-traffic.ts:204-215`). Verified tests:
    - `source/services/logging/provider-traffic.test.ts:172`: `it('sanitizeSentTrafficBody removes encrypted reasoning payload data from messages')`
    - `source/services/logging/provider-traffic.test.ts:203`: `it('sanitizeSentTrafficBody redacts encrypted_content on Responses-API input items (reasoning and provider_opaque/compaction)')`
    - `source/services/logging/provider-traffic.test.ts:808`: `it('ProviderTraffic.recordResponseReceived redacts encrypted_content from a plain-object response payload')`
  - **Correlation ID Precedence:** Uses explicit `meta.correlationId` over ambient process state (`logging-service.ts:336`). Verified test:
    - `source/services/logging/logging-service.test.ts:344`: `it.sequential('uses explicit correlation metadata instead of an overlapping process-global correlation')`
- **Classified Observations & Gaps:**
  - **Schema Passthrough:** `RuntimeLogSchema.passthrough()` allows arbitrary unvalidated fields into log output (`logging-contract.ts:6-24`). **Classification: Design / type gap.**
  - **Validation Failure Continuation:** `LoggingService.log` alters event type to `log.contract_validation_failed` on schema error but writes the unvalidated payload anyway (`logging-service.ts:394-399`). **Classification: Coverage gap.**
  - **Synchronous Write Crash Hazard:** `ProviderTrafficArtifactStore.recordRequestStart` uses synchronous `fs.writeFileSync` without non-throwing catch handlers (`provider-traffic.ts:702-765`). **Classification: Proven product defect.** Contract 07 now retains public-boundary expected failures for all four `IProviderTraffic` siblings and the composed fetch dispatch/error-masking paths.

---

### SB-06 — SSH Transport Lifecycle
- **Owner:** `ISSHService` (`source/services/service-interfaces.ts:123-139`), `SSHService` (`source/services/ssh-service.ts:14-150`), `ExecutionContext` (`source/services/execution-context.ts:17-87`).
- **Disposition:** **Reviewed Contract 06 draft.** The authoritative current
  lifecycle matrix, ten retained red proofs, and exact gate evidence are in
  `.worktrees/sb06-ssh-contract-tests/docs/contracts/06-ssh-transport-lifecycle.md`.

#### Public `SSHService` Lifecycle Matrix

| Operation / Transition | Trigger / Inputs | Contracted / Expected Outcome | Classification | Exact Verified Evidence |
|---|---|---|---|---|
| **Connect Success** | `service.connect()` | `isConnected() === true`, resolves `Promise<void>`. | Characterized & Tested | `source/services/ssh-service.test.ts:66`: `it('connect: establishes connection successfully')` |
| **Connect Failure** | Unreachable / refused host | `isConnected() === false`, rejects with connection error. | Characterized & Tested | `source/services/ssh-service.test.ts:76`: `it('connect: rejects on connection error')` |
| **Disconnect Idle** | `service.disconnect()` | Calls `client.end()`, sets `connected = false`. | Characterized & Tested | `source/services/ssh-service.test.ts:90`: `it('disconnect: closes connection')` |
| **Disconnect Idle (Unconnected)**| `service.disconnect()` | No-op, `connected === false`. | Characterized & Tested | `source/services/ssh-service.test.ts:102`: `it('disconnect: handles already disconnected')` |
| **Server End Event** | Server emits `'end'` | Sets `connected = false`. | Characterized & Tested | `source/services/ssh-service.test.ts:119`: `it('isConnected: returns false after end event')` |
| **Execute Not Connected** | `executeCommand('ls')` while disconnected | Throws `'SSH client not connected'`. | Characterized & Tested | `source/services/ssh-service.test.ts:133`: `it('executeCommand: throws when not connected')` |
| **Execute Success (Exit 0)** | `executeCommand('ls -la')` | Resolves `{ stdout, stderr, exitCode: 0, timedOut: false }`. | Characterized & Tested | `source/services/ssh-service.test.ts:140`: `it('executeCommand: executes command and returns result')` |
| **Execute Failure (Non-Zero)**| `executeCommand('invalid-cmd')` | Resolves `{ stdout: '', stderr, exitCode: 127, timedOut: false }`. | Characterized & Tested | `source/services/ssh-service.test.ts:162`: `it('executeCommand: captures stderr')` |
| **Execute with CWD Option** | `executeCommand('ls', { cwd })` | Wraps command `cd "${opts.cwd}" && ls`. | Characterized & Tested | `source/services/ssh-service.test.ts:198`: `it('executeCommand: prepends cd when cwd option provided')` |
| **Execute Channel Error** | `client.exec` callback error | Rejects execution Promise. | Characterized & Tested | `source/services/ssh-service.test.ts:213`: `it('executeCommand: rejects on exec error')` |
| **In-Flight Disconnect Drop** | Network drops mid-command | Stream listeners lack `stream.on('error')` / `client.on('error')`. | **Residual hypothesis / defect candidate** | Source: `ssh-service.ts:88-109`. Future proof required: red characterization test verifying indefinite Promise hang when SSH socket drops mid-stream. |
| **Execute Timeout Support** | Execution exceeds deadline | Not supported; `timedOut: false` hardcoded at `ssh-service.ts:100`. | **Coverage gap / missing capability** | Public signature lacks timeout parameter. |
| **Execute AbortSignal Support**| Caller triggers abort | Not supported in `ISSHService.executeCommand`. | **Coverage gap / missing capability** | Public signature lacks AbortSignal. |
| **Read File Success** | `service.readFile('/path')` | Executes `cat "/path"`, returns stdout. | Characterized & Tested | `source/services/ssh-service.test.ts:228`: `it('readFile: reads file content via cat')` |
| **Read File Failure** | `service.readFile('/missing')` | Throws error containing stderr. | Characterized & Tested | `source/services/ssh-service.test.ts:245`: `it('readFile: throws on failure')` |
| **Write File Heredoc** | `service.writeFile('/path', text)` | Writes via quoted heredoc delimiter `TERM2_EOF_<ts>`. | Characterized & Tested | `source/services/ssh-service.test.ts:259`: `it('writeFile: writes content via heredoc')` |
| **Write Delimiter Collision** | Content contains delimiter | Throws `'Content contains internal delimiter'`. | Characterized & Tested | `source/services/ssh-service.test.ts:291`: `it('writeFile: throws if content contains delimiter')` |
| **Mkdir Standard / Recursive**| `service.mkdir('/path', { recursive })` | Executes `mkdir` / `mkdir -p`. | Characterized & Tested | `source/services/ssh-service.test.ts:310`: `it('mkdir: creates directory')`, `source/services/ssh-service.test.ts:326`: `it('mkdir: creates directory recursively')` |
| **Remote Workspace Lease** | `enterWorkspace('/path')` | Throws error rejecting local workspace lease in remote mode. | Characterized & Tested | `source/services/execution-context.test.ts:104`: `it('rejects entering a local workspace in remote mode, where the remote dir owns the root')` |

---

### SB-07 — Provider Registry Fetch and Unary Response Types
- **Owner:** `source/providers/registry.ts`, `source/contracts/streamed-model-turn.ts`, provider adapters.
- **Disposition:** **Draft conformance criteria (Contract 02 extension).**
- **Findings & Evidence:**
  - `ProviderFetch` is untyped: `export type ProviderFetch = (url: string, options?: any) => Promise<any>;` (`registry.ts:21`). Causes pervasive `as any` casts across `openai.provider.ts:52`, `openrouter.provider.ts:73`, `codex.provider.ts:256`, and `model-service.ts:16`. **Classification: Type gap.**
  - `StreamedModelTurn.getResponse?(request)` unary path is typed as `Promise<any>` (`streamed-model-turn.ts:67`) and is not forwarded by `RetryingModel` (`source/providers/retrying-model.ts`). **Classification: Type/decorator gap.**
  - `provider_opaque` lane isolation: adapters and turn converters reject foreign provider tags fail-closed on serialization and splicing. Verified adapter/converter declarations:
    - `source/providers/openai-responses-model.test.ts:602`: `it('refuses to splice a non-openai provider_opaque item into an OpenAI request')`
    - `source/providers/openai-chat-completions-model.test.ts:676`: `it('refuses to splice provider_opaque from another provider into an OpenAI-compatible request')`
    - `source/providers/ai-sdk-streamed-model.test.ts:351`: `it('refuses to serialize a provider_opaque item through the AI SDK')`
    - `source/providers/codex-turn-converter.test.ts:122`: `it('refuses to serialize a provider_opaque item into a Codex request')`

---

### SB-08 — Peripheral Service Disposition

#### Deletion and Two-Adapter Test Evaluations

| # | Module Family | Primary Owner | Deletion Test & Two-Adapter Test Analysis | Proposed Disposition | Exact Verified Test Evidence |
|---|---|---|---|---|---|
| 1 | **Handoff session** (`source/services/handoff/`) | `HandoffSession` / `handoffFlowReducer` | **Deletion test:** If handoff is deleted, the session UI loses the `/handoff` command; rest of turn execution is unaffected.<br>**Two-adapter test:** Single in-memory reducer implementation; no alternate handoff adapters exist. | **Local interface is sufficient** | `source/services/handoff/handoff-session.test.ts:17`: `it('owns the handoff state transitions and composes the captured message')`, `:33`: `it('applies the selected model and provider as one policy operation')`, `:45`: `it('sends the captured handoff after effort selection and clears its state')`. |
| 2 | **Model catalog & provider management** (`source/services/models/`, `source/services/providers/`, `source/services/model-service.ts`) | `ModelCatalogSession`, `ProviderManagementSession`, `model-service` | **Deletion test:** If catalog session is deleted, model picker falls back to static defaults.<br>**Two-adapter test:** Providers vary via the provider registry, but the management session has a single UI-facing reducer. | **Local interface is sufficient** | `source/services/models/model-catalog-session.test.ts:10`: `it('caches successful loads and suppresses failed providers until refresh')`, `source/services/providers/provider-management-session.test.ts:4`: `it('keeps provider persistence and deletion behind one session seam')`, `source/services/model-service.test.ts:16`: `it.sequential('fetchModels uses OpenRouter endpoint and caches results')`. |
| 3 | **Workspace/file discovery & active root** (`source/services/workspace/`, `source/services/file-service.ts`) | `ExecutionContext` lease, `worktree-transition`, `file-service` | **Deletion test:** If worktree transitions are removed, tool execution remains pinned to root `process.cwd`.<br>**Two-adapter test:** Single local filesystem / git worktree implementation. | **Local interface is sufficient** | `source/services/workspace/active-workspace-root.test.ts:9`: `it('falls back to the process cwd when no workspace is leased')`, `source/services/workspace/worktree-transition.test.ts:31`: `it('enters a worktree matched by directory name')`, `source/services/file-service.test.ts:7`: `it('scanWorkspaceEntries prioritizes breadth over depth when capped')`. |
| 4 | **Skills discovery & activation** (`source/services/skills/`) | `SkillsService` | **Deletion test:** If skills service is removed, prompt constructor omits the XML `<skills>` block; turn execution proceeds normally.<br>**Two-adapter test:** Single filesystem scanner discovering `SKILL.md` files; no alternate skill backends. | **Local interface is sufficient** | `source/services/skills/skills-service.test.ts:63`: `it.sequential('SkillsService parses correct YAML frontmatter and strips body')`, `source/services/skills/skills-service.test.ts:89`: `it.sequential('SkillsService handles lenient validation - derives missing name from parent directory')`. |
| 5 | **Memory capabilities & store** (`source/services/memory/`) | `FileMemoryStore`, `MemoryCapabilityBuilder` | **Deletion test:** If memory store is removed, agent runs without durable cross-session facts; core turns and tools function.<br>**Two-adapter test:** Single JSON/Markdown file store on local disk. | **Local interface is sufficient** | `source/services/memory/memory-store.test.ts:22`: `it('persists normalized metadata and Markdown content across store instances')`, `:84`: `it('recovers a missing index from the last durable backup')`, `source/services/memory/memory-capabilities.test.ts:76`: `it('guides the main agent to review durable turn outcomes without storing routine conversation')`. |
| 6 | **Terminal notifications** (`source/services/notification-service.ts`) | `notification-service` | **Deletion test:** If notifications are removed, terminal escapes are omitted; assistant behavior is completely unchanged.<br>**Two-adapter test:** Stateless formatting function switching on terminal capabilities (OSC 777, OSC 9, BEL). | **Not a seam** | `source/services/notification-service.test.ts:27`: `it('supportsOsc777 recognizes supported terminals')`, `:88`: `it('notify writes OSC 777 for capable terminals and sanitizes payloads')`. |
| 7 | **Cost/pricing** (`source/services/cost/`) | `model-cost`, `pricing` | **Deletion test:** If cost calculation is removed, usage tracking omits USD dollar estimates.<br>**Two-adapter test:** Pure calculation engine operating over vendored pricing table; no external pricing adapters. | **Not a seam** | `source/services/cost/model-cost.test.ts:46`: `it('parses a plain decimal string into integer micros without binary-float drift')`, `:133`: `it('computes standard input/output arithmetic in integer micros')`, `source/services/cost/pricing.test.ts:6`: `it('returns the standard price for a known provider/model with cache rates')`. |
| 8 | **RTK installation/wrapping** (`source/services/rtk-service.ts`) | `rtk-service` | **Deletion test:** If RTK is disabled or deleted, the shell tool executes commands directly without RTK wrapping.<br>**Two-adapter test:** `rtk-service.ts:148-156` injects `fetchImpl` and `extractImpl` deps (with production defaults at `:198-203`), while the command wrapping logic is an in-process AST rewriter targeting allowlisted POSIX commands. The dependency adapters isolate network/extraction transport, and command wrapping has a single implementation.<br>**Ownership Characterization:**<br>- *Owner:* `source/services/rtk-service.ts`<br>- *Consumers:* Shell execution tool (`source/tools/system/shell.ts:27`)<br>- *Success:* Resolves or downloads cached binary, validates SHA-256, extracts to cache dir, wraps allowlisted bash commands via tree AST.<br>- *Failure:* Returns `null` on unsupported platform, network failure, or extraction failure without throwing or aborting the turn.<br>- *Integrity:* Verifies fixed asset checksum before extraction.<br>- *Recovery:* Seamless fallback to unmodified command execution when binary installation fails. | **Local interface is sufficient (External-effect seam with verified local ownership)** | `source/services/rtk-service.test.ts:156`: `it('wrapWithRtk prefixes a single command with quoted rtkPath')`, `source/services/rtk-service.test.ts:207`: `it.sequential('ensureRtkInstalled returns path when binary already exists')`, `source/services/rtk-service.test.ts:230`: `it.sequential('ensureRtkInstalled returns null for unsupported platform')`, `source/services/rtk-service.test.ts:245`: `it.sequential('ensureRtkInstalled returns null when fetch fails with non-ok response')`, `source/services/rtk-service.test.ts:261`: `it.sequential('ensureRtkInstalled returns null when fetch throws')`, `source/services/rtk-service.test.ts:279`: `it.sequential('ensureRtkInstalled returns null when extraction fails')`, `source/services/rtk-service.test.ts:296`: `it.sequential('ensureRtkInstalled returns null and does not install when checksum does not match')`, `source/services/rtk-service.test.ts:321`: `it.sequential('ensureRtkInstalled returns binary path on successful install')`. |
| 9 | **Local shell interaction session** (`source/services/shell/`) | `ShellInteractionSession` | **Deletion test:** If interactive shell session is removed, terminal operates in standard conversation mode only.<br>**Two-adapter test:** Single session manager for interactive lite shell mode. | **Local interface is sufficient** | `source/services/shell/shell-interaction-session.test.ts:48`: `it('only enters shell mode while lite mode is eligible')`, `:57`: `it('executes accepted commands, forwards SSH execution, and retains their history')`, `:88`: `it('flushes a completed shell history only once when shell mode closes')`. |
| 10 | **Public hook lifecycle** (`source/services/hooks/`) | `HookService` / `HookLifecyclePort`, `HookRegistry`, V1 package contract | **Deletion test:** Removing public hooks removes trusted local observational callbacks while core lifecycle/approval/tool owners retain their own decisions.<br>**Two-adapter test:** `HookService` hides discovery and module loading behind a narrow port; its external `@qduc/term2/hooks` package, schema-versioned events, and documentation are a distinct public protocol rather than another internal adapter. | **Formal public contract already earned; local interface sufficient for `HookService`** | `hook-service.test.ts:26`, `hook-registry.test.ts:19`, `hook-discovery.test.ts:24`, `hook-runtime.test.ts:15`, `hook-system.integration.test.ts:30`; packaged acceptance is recorded in `docs/plans/public-hooks-system.md:10-25`. Manager rerun: 8 hook/path-policy files / 33 green tests. |

---

## Consolidated Implementation Backlog (Separately Authorized Follow-ups)

*Note: All items below are prospective follow-ups awaiting owner review; each requires a dedicated worktree and an exact red characterization test before production code changes.*

1. **Type & Seam Hardening (Low Risk / High ROI):**
   - [ ] SB-01: Close `TurnWorkflow` internal outcome types; replace `outcome: any`, `nextPlan: any`, and untyped option bags with `BuildResultOutcome`, `ContinuationPlan`, and `AgentClientRunOptions`; remove dead `{ action: 'continue' }` at `turn-workflow.ts:975`.
   - [ ] SB-03: Decompose `ConversationAgentClient` into role interfaces (`StreamExecutionPort`, `TurnSteeringPort`, `ProviderConfigPort`) and declare missing methods (`setOnToolDispatch`, `useStandardServiceTierForNextRequest`).
   - [ ] SB-07: Extend Contract 02 C2.6 with adapter-level `provider_opaque` proofs; record `ProviderFetch`, unary `getResponse`, and `RetryingModel` as type/decorator gaps without inventing a production unary seam.
2. **Durability & Error Boundary Fixes (Medium Risk):**
   - [ ] SB-02: Characterize unhandled errors in `loadConversationForProject` and evaluate try/catch wrapper; evaluate atomic temp-file rename in `HistoryService.save()`; characterize residual `.deltas` on `deleteConversation`.
   - [x] SB-05: Characterize provider-traffic fail-open, error masking, index corruption, schema, correlation, and redaction behavior in reviewed Contract 07.
   - [ ] SB-05 repair: after owner decisions, repair the nine proven violations through their owning public boundaries and flip each retained red proof.
3. **Transport & Lifecycle Contracts (Higher Risk / Dedicated Follow-ups):**
   - [x] SB-06: Build and independently review dedicated SSH Contract 06 with deterministic lifecycle and escaping characterizations.
   - [ ] SB-06 repair: after owner decisions, repair the ten proven transport violations and flip each retained red proof.
   - [ ] SB-04: Port-harden `SessionRuntime` by defining narrowed interfaces (`ISessionStatePort`, `ISessionSettingsPort`, `IPendingInteractionPort`) to replace concrete class leakage.
