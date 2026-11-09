---
name: testing
description: Which test tiers exist in this repo during the evidence-driven development experiment, the commands that run them, the rule against committing unit tests, the standards an integration or e2e test is held to, and how to keep those slow tiers fast. Use before writing or changing any test and after making code changes to decide what to run. For how to prove a change works, use the `verification` skill.
---

# Testing

This repository is running an [evidence-driven development experiment](../../../docs/experiments/evidence-driven-development/README.md).
The user-authorized [generated verification pilot](../../../docs/experiments/generated-verification/README.md)
permits persistent bounded generated properties via `pnpm verify:generated`; this
exception does not restore example-based unit tests or replace required tiers.

There is no permanent unit test suite, and no test-first requirement; the global `tdd`
skill does not apply here. Prove changes with the `verification` skill.

## Tiers and commands

```bash
pnpm typecheck                     # every .ts/.tsx change
pnpm lint                          # eslint + prettier check
pnpm test                          # the static repository guards (+ any uncommitted temporary tests)
pnpm test path/to/tmp.test.ts      # run one temporary test
pnpm test:integration              # cross-module and child-process journeys
pnpm test:e2e                      # process-level: terminal UI smoke, build/rollback, fake-codex network
pnpm test:provider-black-box       # built CLI against loopback provider fixtures (see `provider-testing`)
pnpm check:no-unit-tests           # what CI and the pre-commit hook run
```

Keep `NODE_ENV=test` when invoking Vitest directly; the scripts set it. React's
production build lacks `act`.

## Rules

- **Never commit a unit test.** A `*.test.ts(x)` or `*.spec.ts(x)` under `tests/`,
  `scripts/` or `docs/` that the default Vitest config would pick up is rejected unless
  it is one of the guards listed in `scripts/check-no-unit-tests.mjs`. Adding a guard
  needs the user's approval.
- **Temporary tests are fine.** Write them under `tests/` so the default config finds
  them, run them, then delete them before committing. Don't `git add -A` with one in the
  tree.
- **The other tiers stay and run in CI.** Change them when behavior changes. Add to them
  only when the check crosses a real boundary (child process, filesystem, network
  fixture, persisted session, built CLI) and is worth paying for on every CI run. Never
  dress a unit test up as an integration or e2e test.
- **Deleted tests are at tag `unit-suite-baseline`.** Run one temporarily against your
  change if it helps (`git show unit-suite-baseline:<path> > <path>`), then delete it.

## Choosing what to run

- Every TypeScript change: `pnpm typecheck`.
- Provider, bridge, run loop, registry, or non-interactive changes: the provider
  black-box suite.
- Changes the integration or e2e tiers exercise: that tier.
- Package, TypeScript, Vitest, or build configuration: all tiers.
- Everything else: the evidence the `verification` skill asks for. Running tiers that don't
  touch your change is not evidence.

CI runs the independent `quality` job on every pull request and push to `main`: production
typechecking, architecture and repository guards, the static Vitest guards, and review approval
for golden changes. It does not wait for behavioral lanes. Every behavioral tier also runs,
unless every changed file in a pull request is inert (the `changes` job in
`.github/workflows/ci.yml` defines inert); then only the expensive test work skips. The required
`test` job still checks the root allowlist and rejects committed unit tests before dependency
setup. `integration` owns `bench/headless.mjs` and `bench/hops.mts`; `e2e` owns golden parity.
`bench/headless.mjs` runs its isolated rows through a core-sized pool (`HEADLESS_CONCURRENCY=1`
for serial debugging); serially it added ~30 s to the integration lane's critical path. The
heaviest e2e files run in the `test` lane (`owner()` in `scripts/run-ci-lane.mjs`); rebalance
there when one lane finishes well after the others. Do not move PTY-driven e2e files onto
`provider-black-box`: two of them took that lane from ~62 s to 94 s locally and tipped a heavy
provider case past its ~40 s deadline, the same timeout class that already flakes there in CI.
`port` is a compatibility aggregate requiring quality and test success, plus successful behavioral
lanes or skips justified by an inert pull request. Known docs/evidence formats may skip tests;
unknown extensions and executable scripts under `docs/` run every tier. Follow any late CI failure
through to a passing run or a blocker someone clearly owns.
Never claim a test, build, or check passed unless you ran it and it succeeded. For long runs, set an
explicit finite timeout and wait for the completion notification rather than polling.

## Standards for integration and e2e tests

- Exercise observable behavior through public entry points: the CLI, a service facade,
  or a protocol boundary.
- Assert structured values (codes, statuses, persisted records) over raw strings or
  broad snapshots, unless the text is the contract.
- Deterministic and independent: no real provider network, no shared fixed temp paths,
  no writes into the repository tree, runnable in any order.
- Mock only at external boundaries (provider fixtures, the network guard).

## Keeping the slow tiers fast

Every integration, e2e and provider test pays its cost on every CI run, and these
tiers spend most of it waiting, not computing. On base `8a4617c` the e2e lane
summed 579 s of test time on three workers while the 4-vCPU runner sat at 160%
CPU. The attribution and measurements are in
`docs/plans/engineering/measurements/test-suite-speed-2026-10-22.md`,
"E2E lane root causes". When you write or change a test in these tiers:

- **Count built-CLI launches.** A launch to an idle composer measured about
  0.55 s locally, more on hosted runners; ~236 launches were 42% of that lane's
  time. Within one test, check the steps of one journey in one session rather
  than relaunching per check, and relaunch only when the claim is about a
  restart. Tests still never share a session.
- **Launch the built JavaScript with plain `node`.** `--import tsx` on the
  bundle took `--help` from 0.5 s to 4.1 s.
- **Keep the V8 compile cache.** The e2e, integration and provider global setups
  prime it with `prepareCliCompileCache()`, and `createTestChildEnv()` forwards
  `TERM2_TEST_NODE_COMPILE_CACHE` as `NODE_COMPILE_CACHE`. A hand-built child
  environment (`env -i` in `first-run-setup.e2e.test.ts`, the Discord CLI e2e)
  must pass it on itself: ~175 ms of a ~500 ms launch. The entry's loader keeps
  the bundle's V8 code cache in the same directory (`term2-bundle/`); the `--help`
  priming writes a partial one, and the first launch that lives past 2 s writes
  the full one (see `src/app/README.md`, "Startup loading").
- **Drive PTYs through the shared bridges.** `spawnTerminal()`
  (`tests/helpers/terminal-e2e.ts`) and the provider harness answer the TUI's
  Device Attributes query with `PYTHON_DA1_RESPONDER`. A bridge without it makes
  every launch and restart wait out `detectTerminalBackground()`'s 150 ms
  backstop (`DEFAULT_DETECTION_TIMEOUT_MS`).
- **Copy `dist/` with `copyBuiltCli()`, and only when the test needs its own
  copy.** `fs.promises.cp` took 1.15 s idle and over 3 s under load;
  `copyBuiltCli()` (synchronous, skipping maps and declarations) takes
  0.08–0.13 s.
- **Wait for a condition, not a duration.** A generous timeout on
  `waitForOutput()`, `expect.poll()`, `waitForDirectComposer()` or
  `waitForHarnessIdleGeneration()` costs nothing when the test passes; a fixed
  sleep costs its full length on every run. Where the product publishes a
  harness signal under `TERM2_HARNESS_IDLE_PATH` (idle generation, `.composer`
  revision, `.approval` readiness), prefer it to matching screen text.
- **Sleep only to observe that nothing happened,** and say in a comment why that
  length is enough. About 60 s of such windows remain in the e2e lane; they are
  the next thing to replace with a deterministic quiescence signal, so don't
  add more without need.
- **Don't wait out a product deadline in real time.** Speed up the clock the
  guard reads, from the child's `--import` preload. `discord-cli.e2e.test.ts`
  divides `AbortSignal.timeout` and the one-second `timers/promises` sleep by 5
  (republished with `syncBuiltinESMExports()`), so the bridge's own 10 s REST
  deadline still decides the boundary, in 2 s. Don't add a production override
  just so a test runs faster: the guard ledger
  (`docs/plans/approvals-and-sandbox/guard-ledger.md`) records which guards have
  one, and the Discord bridge has none.
- **Size fixture pauses to what the assertion needs, and write the arithmetic
  down.** The `/usage` fixture in `approval-mode.e2e.test.ts` must stream slowly
  enough to stay under the status bar's 500 tok/s plausibility cap
  (`MAX_PLAUSIBLE_DECODE_TPS`). 73 tokens over 400 ms keeps the same ~250 ms
  margin that 731 tokens over 1.7 s did.
- **Keep wait predicates cheap.** Waits poll every 20–25 ms for the whole test,
  and workers share the CPU. `getVisibleOutput()` re-strips ANSI only when the
  output grew; don't re-process the whole session on every poll.
- **Attribute a slow lane's time before changing it.** If CPU time is far below
  summed test time, the tests are waiting, and more workers or split files only
  repack the waiting. A temporary Vitest setup file that recorded each CLI
  spawn and each test-file `setTimeout` found the causes above; `node
  --cpu-prof` on the built CLI shows where startup goes.

## Recurring verification traps

These are historical diagnostic leads, not blanket exemptions from failing gates.
Match the signature and environment, inspect intervening fixes and reproduce on
base when needed. A passing rerun does not explain or erase an earlier failure.
Exhaustive former run records are in git history at `42724797` (remote source)
and `68ef50ff` (local-only evidence), not a result file to resume appending.

- **Approval fixture temp authority:** inherited app-suffix `TMPDIR` put ordinary
  targets inside the child's permitted scratch root. Five reused-call-ID cases
  returned YELLOW instead of expected RED; the Bare outside-write target was
  created. Isolate child `TMPDIR`/`TEMP`/`TMP`, keep ordinary outside targets
  outside both workspace and child scratch, and retain intentional scratch-write
  controls. A unique directory is not a distinct permission root. See
  `docs/agent-context.md`, “Shell Safety For Agents”.
- **PTY waits:** `turn-decisions.blackbox.ts` has recorded 40,000ms repeated-question
  waits with Amber/Violet or `SELECT_A_SECOND_COLOR` visible; restart e2e has a
  5,000ms composer acknowledgement wait “after revision 2; got revision 3”.
  `input-notice.blackbox.ts` once timed out after 40,000ms waiting for `/retry-turn`
  “after revision 3; got revision 4”. The composer still held the submitted text
  and image marker, so the command was appended to them. This happened in a full
  lane on Node 22 on 2026-11-07, and 36 reruns did not reproduce it.
  `input-cache-guard.blackbox.ts` failed in its “third request after confirmation”
  phase the same day, in a full provider lane on Node 24. The second Large request
  prompt was visible, but typing `y` sent no request within 40,000ms. In 14 reruns
  on each build, half beside busy loops, plus another full lane on each, it passed
  on both the change and its `main` base.
  Unchanged-source reruns passed, but the recurring signatures' root causes were
  not established. Do not increase product deadlines or declare concurrency the
  cause from that alone. A separate fixed harness defect missed an already
  captured HTTP request when no later PTY event woke its waiter; test HTTP-only
  wakeup and an unmet-predicate timeout, not just terminal output.
- **Identical menu redraws:** first-run setup closes/reopens its model picker
  after Escape. With an empty filter, Ink can coalesce those transitions into
  an unchanged frame and emit no new `Filter:` bytes. A new-output wait then
  times out despite a live picker. Type a throwaway query before Escape and
  assert a fresh, line-terminated empty filter, then finish model selection.
  This observes reset/recovery rather than requiring an identical repaint;
  a no-reopen mutation must fail at the reset assertion. A controlled
  hook/controller/Ink probe reproduced this mechanism; the original full-CLI
  CI timing was not reproduced locally.
- **Direct e2e teardown race (fixed 2026-11-07):** `tests/cli/settings.e2e.test.ts`
  failed intermittently with `ENOTEMPTY: directory not empty, rmdir
  '<tmp>/term2-tool-rows-e2e-*/home'` (or `home/.local`) and no assertion
  failure; it reproduced on unmodified `main` `d7bf2ff` in 3 of 6 isolated runs
  (2026-11-04), and `tool-output.e2e.test.ts` hit the same signature on
  `8a4617c` plus local changes (its throwing `afterEach` then left
  `providerRequests` unreset, failing the next case by count). `dispose()` in
  `tests/helpers/terminal-e2e.ts` killed only the Python PTY bridge, which merely
  hangs the CLI up; the CLI outlived it and could still write under HOME while
  `afterEach` ran `rmSync`. `dispose()` now SIGKILLs the CLI's process group via
  `killPtyChildren()` first (Linux). A probe measured the CLI surviving ~15 ms
  after the old teardown and 0 ms after the new one; 5 repeated runs of
  settings, tool-output and approval-mode e2e then passed. If the signature
  returns, look for a writer outside the CLI's process group (shell commands run
  in their own groups).
- **Build/host isolation:** suites that replace `dist` in one worktree must run
  sequentially; overlapping builds produced transient missing-module errors.
  Missing `dist/cli.js` is setup failure, not behavioral red proof. Child-process
  tests must isolate persisted config/task storage and inherited `XDG_STATE_HOME`.
  macOS fixtures also exposed `/tmp` canonicalization, Linux-only XDG paths,
  `/dev/full` assumptions, Yoga headless startup and wrapped terminal text.
- **Shared build-output race:** `pnpm test:provider-black-box` rebuilds the CLI
  before testing. Do not run that command concurrently with integration/e2e
  readers in the same worktree: the build moves `dist` aside, so readers can
  see missing `dist/src/app/cli.js` or prompt assets. Build first, then run
  reader tiers against stable output (or use isolated worktrees). These missing
  files are setup failures, not behavioral red proof.
- **Toolchain unlike CI:** CI's `setup-tests` installs Node 24.21.0, pnpm 11,
  `bubblewrap` and `socat`, and does not run as root. A cloud container may
  differ on each, and the same failures appear on the base. Lane failures this
  produced on 2026-11-07:
  - Without `bwrap`/`socat`, 12 Bare-profile cases in `cli-headless.integration`
    got “Sandbox blocked this command”.
  - As root, `chmod 0o555` blocks nothing, so two `logging-failures` cases failed.
  - With pnpm 10, `pnpm publish --dry-run` delegated to npm 11 and contacted the
    fixture registry, failing three `release-identity` cases.
  - On Node 22, the Discord stalled-body deadline test timed out.

  Match CI's toolchain before treating such a failure as a regression. After
  switching Node, rebuild the native addons (`better-sqlite3`, `ssh2`,
  `cpu-features`).
- **Native serve fixture migration:** a failure reading `manifest.json` just after
  `GATEWAY_READY` is before turn execution or SIGTERM. The native launcher persists
  dynamic grants in `direct-workspace-grants.json` and sessions in `conversations/`,
  not the retired manifest or `gateway-data`. Its SSE tests must negotiate
  `format=direct` and assert native events; an unqualified request returns HTTP 400.
  Check stream status/format before awaiting events so negotiation failures do not
  masquerade as turn timeouts.
- **Lint scope:** broad lint in the shared primary checkout scanned untracked
  `.cache`, `.coord`, `.term2` and `packages` artifacts. Local-only runs at
  `99e31c51` and `207f6427` classified all 9,431 errors plus three warnings as
  untracked, while tracked files had zero errors/31 warnings. Classify current
  paths before calling a failure pre-existing. Scoped success is not full-lint
  success. The former result JSON itself repeatedly failed Prettier; its removal
  does not establish that other formatting failures are gone.
- **Fixture timing/settings:** fixed event-loop counts raced Discord detached
  completion; wait for exact output and durable job completion instead. Unsupported
  sandbox environment flags left restart fixtures on “Allow this action” when
  `bwrap`/`socat` were unavailable; use supported persisted fixture settings and
  exercise the missing-dependency host. A 150ms repair deadline included real
  Git/SQLite snapshot work, expiring before repair; control the task clock while
  retaining the real boundary. Check residue after runner shutdown too: passing
  suites once leaked per-suite cache directories on success/failure/collection errors.
- **Provider catalog policy:** OrcaRouter once listed image/video/embedding models
  as chat-capable after a generic mapper discarded capability metadata; moving
  vendor filtering into that shared mapper then wrongly filtered other custom
  endpoints. Check heterogeneous network catalogs, cached pre-filter rows and an
  unrelated endpoint with identical metadata. Scope vendor policy to its endpoint.
  A later nullable model-list type change also broke compilation in this caller;
  typecheck the integrated tree, not only the pre-merge branch.
- **Independent oracles:** Discord reaction fixtures incremented the sent ID
  twice (created IDs 10/12 versus acknowledged 11/13); assert the association
  against actual acknowledgements. Discord image fixtures must stage outside the
  app scratch root: an inherited app-suffix `TMPDIR` otherwise bypasses read approval
  and can mask invalid settings. On load, `shell.autoApproveMode: always` with
  `sandbox.enabled: true` is deliberately demoted to `auto`; an unattended-read
  fixture must configure both settings consistently. Image bytes reached model input
  even though completed job text had cleared `read_file`; observe the model request,
  not an unrelated transient field. Headless approval-required results do not prove a
  bypass; an interactive approval claim needs an interactive owner.
- **term2-next parity (rewrite, 2026-11):** a 98/98 e2e suite and 9/9 goldens
  stayed green while menus lost styling, ten commands were invented and steering
  changed. The e2e asserted strings written for next on ANSI-stripped output, and
  the goldens ran headless, so neither ever ran legacy. Only a side-by-side diff
  against legacy (cells including colours) counts as parity evidence; see the #65
  acceptance criteria.
- **Empty-store fixtures hide data-size costs:** the composer footer read every
  conversation `.jsonl` on every render. With a 465 MB store that meant about 1 s
  key echo and 150% CPU. PTY probes using an empty temp store never showed it. Run
  latency checks against a copy of a realistically sized store, and profile the
  real session (`--cpu-prof`) before theorising about terminal rendering.
- **Timing reds under load:** a direct/provider measure at load 19.5 on 7 cores
  gave 8 + 25 reds that mostly passed when re-run on a calm box; CI was green.
  Ctrl+U input timing recurred under load. Record host load and re-run the same
  case on a calm box, comparing base and candidate under matching conditions.
  A passing rerun does not explain the earlier failure, and a fixed load cutoff
  cannot establish its cause or waive a failed gate.
- **PTY relaunch lock race:** relaunching before the previous PTY child had exited
  raced the personal-memory lock and flaked CI. The harness must wait for child
  exit before relaunching; don't paper over it with retries.
- **Idle is not "frame on screen" (fixed 2026-11-07):** the harness idle file is
  written from a React effect, so the frame can still be in flight through the
  PTY bridge. `approval-mode.e2e.test.ts` › "keeps all composer hints at 120
  columns" read the screen right after idle and failed under load with
  `expected [] to have a length of 1` (no hint row), 3 of 12 on `main` and 2 of 12
  on the candidate beside four busy loops. Wait for the text you will assert on
  (`waitForOutput`) before reading `getVisibleOutput()` after an idle wait.

### Local-only boundary lessons reviewed for reconciliation

These failures came from the October 29–30 local candidates, not features newly
implemented by this documentation cleanup. Preserve their evidence when combining
branches; do not infer that remote source `42724797` has those capabilities.

- **Human timing:** deriving gaps before FIFO admission used stale history and
  emitted two notices for 02:00/02:01 steers after a 00:00 input. Receipt timestamps
  were also lost from recovered pending items. The accepted timing candidate
  `a0375335` derived at admission and persisted the original timestamp; dispatch
  time is not arrival time. Released-steer reordering needs a monotonic human baseline.
- **Rollover timing:** same-leaf resume coverage missed the successor's absent
  predecessor human baseline. A built-CLI rollover/resume case on `bc96f19d`
  expected one timing notice and saw none; repair `a5a0ebb3` carries the checkpoint.
  Missing/invalid legacy checkpoints must not invent a time. Sanitized wire output
  alone does not prove absence; inspect canonical history. Natural hour-gap live
  acceptance was still pending in those records.
- **Chained memory delivery:** a persisted edited snapshot did not prove OpenAI
  received its sibling data notice: the chain filter sent human text alone.
  `fa0fd319` repaired the trailing user/system-timing block after a loopback-provider
  red case on `3744dd59`. Codex/general success had not covered OpenAI chaining.
- **Migration guards:** synthetic layer-map cases missed real A1/A2 dependency
  closures. The accepted G1 traversal at `2525064b` applied root adopter permissions
  beyond lawful source-layer transitions and omitted shared-origin edges. Exercise
  the real adapter closures as well as synthetic boundaries, not just a green guard.
- **Direct executable migration:** the M1 broad run on `9e2f2c30` recorded 65 legacy
  CLI integration failures and 27 provider failures (interactive-terminal refusal
  or unknown `--provider`/`-p`). Hundreds of other passing provider cases did not
  reach the direct path. Those totals were neither M1 coverage nor a passing tier;
  keep executable routing explicit when interpreting migration evidence.

- **Native SQLite shutdown on Node 24.19.0:** `better-sqlite3@12.4.1` can abort
  on fork/resume with `node::RemoveEnvironmentCleanupHook`, `Assertion failed:
  (env) != nullptr`, and `Database::~Database()` or `Statement::~Statement()` in
  the native stack. This reproduced on unmodified `main` `cb165c8a` in the resume
  PTY suite during #212; a child can exit by signal (`exitCode: null`) or leave
  the harness waiting for an idle file that will never arrive. A passing rerun
  does not explain the native abort. Inspect the child's stderr/exit before
  attributing a missing resume frame to rendering changes; the native cause and
  repair remain unresolved. The explicit CLI resume/fork idle timeout also
  reproduced on that base, without a captured native stack for that timeout.

## Prompt and instruction changes

Prompt text under `src/session/prompts/` is product behavior. When trimming a prompt, show
that its non-obvious content survives. For example, run the assembled prompt for the
affected model and confirm the text is present, or run a non-interactive turn that
depends on it.
