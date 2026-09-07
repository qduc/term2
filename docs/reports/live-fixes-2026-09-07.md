# Live verification fixes (2026-09-07)

## Resume here

User FIX-AUTHORIZED. Both source fixes merged to main: worker bootstrap
merge e5dad4ba (implementation dc5042fa), Codex compaction identity merge
183d7072 (implementation 6172b63c). No push. User untracked
docs/plans/run-code-nested-approval-preflight.md untouched.

Final integrated combined gate completed at main183d7072: build/typecheck,
e2e12passed and provider177passed/1skipped; full suite20failed/8348passed.
Exact failure comparison: new[], gone[] versus baseline20. No green full-suite
claim. Main rebuilt successfully. Temporary compaction/removal-probe worktrees
cleaned; evidence retained. No source work remains for these scoped fixes.
All live R2/R3/R4 repeats passed with wire evidence below. Owned child in
herdr w18:p4/tabw18:t4 was stopped with Ctrl+C after R2 settlement; no other
panes controlled. Evidence state remains outside removed disposable roots.

## Shared bootstrap repair

The earlier deleted-cwd repair only installed preload when parent process.cwd
threw ENOENT. Node caches cwd, so deleting the directory after interactive
startup bypassed that decision. Real source/built sandbox cached-cwd tests and
source/built index-worker startup tests failed before this fix (4fail/2pass).
The old uncached sandbox cases alone were insufficient.

workerBootstrapExecArgv in source/utils/worker-bootstrap.ts now prepends an
absolute worker-local preload for both production Worker constructors:
sandbox.ts and session-index-worker-client.ts. Preload checks whether the
worker cwd still names a directory, falling back to its own directory on ENOENT
or non-directory only. Other errors propagate. Parent cwd and startup flags
remain unchanged; VM bindings and logical filesystem authority are unchanged.
No parent-only TOCTOU decision and no silent relative-write retarget.

Final real-child e2e matrix: source/built x sandbox/index x healthy/deleted/
cached-deleted cwd =12 passing cases. Parent cwd/ENOENT state, inherited
diagnostic startup flags and sandbox VM isolation are asserted. Focused unit
tests33passed; build/typecheck/formatting/diff-check passed. Related/changed
gates each1105passed/4failed; those four match baseline identities below.

## Live R3: deleted launch directory PASS

Fresh interactive process used fixes/dist from disposable .live-cwd; directory
removed after TUI startup. Session0a791d99-4146-44e2-990b-91db71855a62, request
94032d2a-5116-4f0b-83e7-fe9593af9424 contains actual function_call_output:
session_list total1/unavailable0, scope still deleted .live-cwd; absolute
settings-path.ts read23lines after Allow once. FIXVERIFY-R3-FINISHED observed.

## Live R4: whole launch worktree removal PASS

Created clean owned .worktrees/live-root-recovery-probe inside fixes worktree.
Launched fresh child there using fixes/dist outside it. Verified TUI, then
git worktree remove succeeded227ms while child remained live. Session
9f478458-9da5-4128-af12-ffa882873a2a, request716c8d1d-7de0-4e59-a348-9348a864f324
contains session_list total1/unavailable0, scope still deleted worktree. Request
feec5266-bd26-4db6-8211-7d3524199ca5 contains absolute settings-path.ts read23lines
after Allow once. FIXVERIFY-R4-FINISHED observed. No root recreation or chdir.

Recovery contract: worker startup tolerates missing launch cwd while runtime
assets remain extant. This does not promise shell execution in missing cwd or
survival if runtime assets themselves are removed. Both original repros used
an extant runtime outside the deleted root. No deletion guard added: external
Git is outside application admission; a command classifier cannot prevent it.

Actual policy trace: shell.needsApproval may skip classification when sandbox
is available. gitHandler marks worktree YELLOW without inspecting removal
target ownership. rmHandler classifies active-root-relative paths and rejects
preexisting/unverified paths, but has no live-process ownership check. Shell
executor spawns with logical cwd, without removal-specific validation. Dedicated
enter/exit_worktree tools guard background-job transitions, not deletion.

## Codex identity repair and live R2 PASS

HTTP codexHeadersMiddleware formerly supplied root sessionId to compact headers;
ordinary worker WS identity already selected providerHistoryKey. Middleware now
uses providerHistoryKey ?? sessionId for compaction while keeping ordinary
root session_id observability unchanged. No run-loop or chain code changed.

Three middleware-boundary tests cover distinct root/worker, root fallback and
ordinary request behavior. RED old selection1failed/41passed; final provider
unit pair142passed. Typecheck/eslint/prettier passed. Provider black-box
177passed/1skipped. Related/changed gates reported20baseline-class failures.

Fresh live session8cedaf23-d137-4310-9016-c1384e893ea9 used built6172b63c and
isolated native compaction threshold20000tokens. Worker ample-nebula-316 read
settings-schema.ts, settings-service.ts and agent.ts then completed. Trigger
511ac1b2-16c0-40f9-b099-0213ec809536 received HTTP200,22500input tokens. Headers
session-id/thread-id and turn metadata all used root:subagent:ample-nebula-316.
Worker requestf503751a-0522-4223-8a70-802562ee620d reused compaction artifact
cmp_0b8770fa3f2656d3016a9e644db48887d0988a6ec3ca103578 with no previous_response_id.
Following worker requests chained normally. Root request
807b896e-9a82-4e29-87bd-5a17757ef054 retained its pre-compaction response
resp_09edb3baef984db9016a9e6444906087d0b668939f3fae463e, with no worker artifact.
Root anchor ROOT-FIX-ANCHOR-741 and FIXVERIFY-R2-ROOT-FINISHED returned.

Wire evidence base: /home/qduc/term2/.worktrees/live-verify-evidence/
.live-verify-state/term2-nodejs/logs/provider-traffic/2026-09-07/.
R3 folder06-52-51_0a791, R4 folder07-08-24_9f478, R2 folder07-13-34_8ceda.
Original pre-fix evidence: docs/reports/live-verify-2026-09-07.md at92d06fe7.

## Gates and historical shell statuses

Final integrated gate7c80dfad-8f4e-410e-9d6f-c4c976cff397: exit1,226786ms.
Build/typecheck passed; e2e12passed3.13s; provider177passed/1skipped60.38s;
full20failed/8348passed/3expected-fail/2skipped145.74s. Compared normalized
file + full test name sets against baseline20: new[], gone[].
Log /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788765642062-47f071.txt.


Bootstrap combined gate a8eaa8b6-c878-485f-b759-192e29f9917a: exit1,228426ms.
Build/typecheck passed; e2e12passed3.12s; provider177passed/1skipped63.30s;
full20failed/8345passed/3expected-fail/2skipped144.41s. Exact failure headings
compared against original baseline: no new identities, none gone.
Log /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788765318445-431610.txt.
Baseline /tmp/qduc/term2-nodejs/tool-output/output-4026698-1788755708597-31f8ee.txt.

Eight historical parent validation jobs are7real exit1 test failures and1exit0,
not cancellation, rollover loss, or child R1 jobs:

- 6667436a-f1c5-4765-ad09-c08c71055b3a: pnpm test, exit1,264667ms,22failed8278passed.
- a253a0e4-e1cc-4d1f-ba97-e1c2877a51b4: pnpm test, exit1,144818ms,21failed8289passed.
- 3fcbd9d0-543a-4822-8734-15ace62a52e0: pnpm test, exit1,159483ms,20failed8290passed.
- ba3bb944-76dd-43da-8c0f-6a7dc64c62a9: pnpm test, exit1,141448ms,20failed8304passed.
- d6196d25-ee47-4f74-b318-fad91847987a: typecheck/provider, exit0,71264ms,177passed1skipped.
- 72940092-34a1-47ce-bdb3-3ea271eced90: provider/full, exit1,206546ms,20failed8320passed.
- 5d3a7ab7-626f-4c24-b2ac-e0c9e2821ffe: provider/full, exit1,212025ms,20failed8344passed.
- f7fa11b7-9c1e-42c8-9909-f63312900b82: combined, exit1,216530ms,20failed8345passed.

## Defect-class retrospective

Both preventable. Bootstrap ambient cwd validity cannot be guaranteed by a
TypeScript type; filesystem state can change externally. The shared preload
centralizes the recovery boundary across both constructor sites (grep confirmed
exactly two). Parent cached cwd and worker loader timing were implicit coupling;
old tests covered uncached deletion, not interactive cached state or sibling
index startup. The12-case real-child matrix is the structural prevention.
Origin: earlier repair8668d892 and followups incompletely covered a latent
ambient-cwd dependency; exact initial introduction not established.

Compaction allowed root and provider identity as interchangeable strings. HTTP
and WS had independently selected identity, so helper tests never represented
distinct root/worker context. Middleware regression tests now assert the actual
selection boundary and correlated metadata; WS sibling was already correct.
addCodexCompactHeaders originated7d53a3ca; this was latent in that HTTP path.

Automation: typecheck cannot prove either runtime invariant; boundary tests are
proportionate, no new lint rule or identity-type refactor added. Knowledge gap:
prior tests encoded a narrower invariant than live behavior. Observability:
real uv_cwd failures and wire headers exposed both in the2026-09-07 live study;
exact total latent lifetime unknown. No logging change needed because existing
artifacts carry request identity and results. No further structural work deferred
for these scoped defects; deletion of runtime assets remains explicitly outside
the recovery contract.
