# Independent acceptance follow-ups — 2026-10-24

## Scope and source identity

Independent verifier, assigned by the controller; not an implementer of these
repairs. This is acceptance evidence, not a new product delivery or an experiment
quality/cost comparison. No production source, defaults or permanent tests changed.

Tested source: `36b490f27c937c0e4852614aba5c21cf136621ad`, tree
`c2ac0113f9e3715de96d18f0ef8a0d3757bcd664`, branch
`codex/edd-acceptance-verification`. Temporary untracked probes were present;
tracked source matched this revision. Worktree-local `pnpm install` was run.
Linux `7.0.14-17-pve`, Node `v24.19.0`, pnpm `11.7.0`;
runner TMPDIR `/tmp/qduc/term2-nodejs`, outer NODE_ENV `production`;
Vitest commands set NODE_ENV `test`.

Before execution, checked current main's four-run index, the frozen continuation
file and task rows, and top-level `/tmp` acceptance/verdict candidates. No newer
independent verdict for these three gaps was found within that search. The
similarly named `/tmp/edd-acceptance-verification-20261024.md` was the assignment,
not an acceptance verdict. Main later integrated guidance as `de7f05f0` and
`40db1931`; its delta from the tested source is documentation/ledgers only.

## Verdicts

| Follow-up | Claim | Verdict | Decisive evidence |
| --- | --- | --- | --- |
| EDD-LOG-01 | Actual ENOSPC is nonfatal; one warning across instances; later payloads neither exposed nor buffered | ACCEPT | Two physical `/dev/full` sink error events recorded `ENOSPC`; both disabled; 100 subsequent 8 KiB writes per logger left buffers zero and produced no payload/Winston noise; pre-initial-fix body crashed and pre-review-repair body exposed/buffered later writes |
| EDD-LOG-01 | Built CLI completes despite activated sink failure | ACCEPT | Existing CLI integration case passed with local/UTC divergence, one warning and one loopback provider request |
| EDD-LOG-01 | Application local-day retention, traffic UTC retention, nonfatal cleanup and readable-sibling measurement | ACCEPT | Five focused cases passed; fixed-clock Kiritimati process retained local application day and UTC traffic day under sparse >512 MiB pressure; old local-date body deleted active local log; explicit EACCES activation plus historical sibling negative control |
| EDD-ROLLOVER-01 | Real queue/turn-start/turn-end trigger; no premature rollover; exactly-once original-queue delivery | ACCEPT | Actual ConversationService queue plus actual Ink hook reached first turn-end while queued successor was running and queue-owned with zero remaining entries; current blocked; historical service/hook failed final admission |
| EDD-ROLLOVER-01 | Callback rejection contained; visible briefing; no automatic resend | ACCEPT | Actual hook received a rejected callback once, rendered its error and preserved brief; one original turn, no successor. Parent emitted unhandled rejection and omitted the briefing |
| EDD-VERIFY-01 | Staged and untracked whitespace are checked in attested set and route to repair | ACCEPT | Real Git/filesystem/SQLite cases: 2 current passes; both historical checker controls incorrectly returned complete |
| EDD-VERIFY-01 | Built CLI gives named unsupported-workspace block and task/workspace alert without attested row | ACCEPT | Exit 2, named reason, one actual application-log operational alert; task hash matched persisted goal ID and workspace; no verification DB created |
| EDD-VERIFY-01 | Default-on built-CLI gate and persistence are real, not vacuous | ACCEPT | Both verifier-model selections made four requests and persisted COMPLETED / independent_verify / PASS. Effective-default-false control made two requests and failed both four-request assertions |

Acceptance is limited to these mechanisms and exercised paths, not all logging
failures, rollover environments, or verifier judgement quality.

## EDD-LOG-01

Tasks: `2026-10-22-log-enospc-failure`,
`2026-10-22-log-enospc-review-repair`,
`2026-10-22-log-enospc-local-date`.

- `TZ=America/Adak pnpm test:integration source/services/logging/logging-failures.integration.test.ts --reporter=verbose`
  — 5 passed, command wall 2.320 s.
- Same TZ, `pnpm test:integration source/cli.integration.test.ts -t 'finishes a provider turn when file logging hits ENOSPC'`
  — 1 passed / 54 skipped, 5.087 s.
- An isolated process froze its clock to `2026-10-23T12:30:00Z` with
  TZ=Pacific/Kiritimati: local date 24, UTC date 23. The probe observed real
  WriteStream error events without installing a swallowing error listener.
  Both paths were owned fixture symlinks to `/dev/full`; exactly two ENOSPC
  events proved activation. Current stderr was one 99-byte warning; disabled
  flags were `[true,true]`, writable buffers `[0,0]`.
- Under identical stimuli, body from `c778010c^` exited 1 on unhandled ENOSPC.
  Body from `220fd838^` left buffers `[84,84]`, emitted repeated Winston output
  containing synthetic private sentinels, stderr 270310 bytes. Current did not.
- Retention probe seeded sparse files, never large physical payloads. Current:
  active local app log survives, old app log removed, UTC app-day group
  evicted under pressure; traffic UTC day survives and local-only next-day
  group is evicted. `635513c3^` instead deleted active local app log.
- Temporary sibling probe first asserted actual `readdir` EACCES, then verified
  the oversized readable day was removed: current passed (1.567 s), body from
  `220fd838^` failed because that day survived (1.721 s).

Retained ineffective/extra attempts:

- Initial unchanged five-case run at TZ=Pacific/Kiritimati: 4 passed / 1 failed
  (1.717 s). At actual UTC 00:31, local and UTC dates were both 24; the test's
  timezone-only assertion stopped *before* injection. This is a clock-sensitive
  test-premise defect, not a production logging failure. No assertion was edited;
  the actual-divergence run and fixed-clock process supplied the missing stimulus.
- An exploratory probe explicitly called private Winston `logger.clear()` on a
  disabled logger. Both current and parent then buffered/emitted data. This
  manufactured unsupported internal state, unlike the natural file-failure
  path above; it supports no reachable product-defect claim and is excluded
  from acceptance. The aggregate control runner exited 1 because of that
  overbroad exploratory assertion. Its per-case results and stderr are retained.

## EDD-ROLLOVER-01

Task: `2026-10-22-rollover-queued-submission`; related recorded defect:
`2026-10-22-rollover-queue-turn-end-crash`. Its introducing task remains unknown;
this verifies the repair, not the ledger's causal origin.

Temporary probe used real ConversationService/runtime/queue, branded streams,
real `session.prepare` / consume / completed operations, actual React Ink hook
rendering, and owned filesystem sequence logs. Only the agent-client external
boundary was controlled. It implemented the required `runTurn(session)`
protocol, avoiding the earlier probe's missing start boundary.

Sequence reached:

1. First input prepared; first stream emitted turn-start and waited on barrier.
2. Queued input was submitted; rollover request installed; first turn released.
3. Original queue started second input; second stream emitted turn-start.
4. Actual first-hook turn-end consumed rollover while owning=true, kind=running;
   no queued entry remained because it was already the active successor turn.
5. Current returned blocked, never invoked rollover callback, and then delivered
   the second input once. Session stayed `edd-original`; visible brief remained.
6. Separate case forced a ready-result/final-admission race to inject a rejected
   callback. Current rendered rejection and brief, called it once and did not resend.

`pnpm test:integration source/edd-rollover.integration.test.tsx --reporter=verbose`
— final current 3 passed (3.428 s). Identical probe with EDD_CONTROL=parent
loading pre-repair service/hook bodies: 3 failed (3.372 s), including ready
instead of blocked, missing callback-rejection briefing, and synchronous final
admission rejection. Vitest also captured the callback's unhandled rejection.
Initial two-case current/parent runs (3.272 / 3.421 s) are retained.

This is a controlled real-conversation/Ink boundary, not a full PTY or live
provider run. It certifies the reached interleaving and callback containment,
not every scheduler or App writer failure.

## EDD-VERIFY-01

Task: `2026-10-19-adaptive-independent-verification-review-fixes`.

- `pnpm test:integration source/services/completion-verification/completion-verification.integration.test.ts -t 'inside the attested revision|an unsupported workspace blocks' --reporter=verbose`
  — 3 passed / 36 skipped, 3.971 s. Cases use actual staged/untracked whitespace,
  current snapshot attestation, and real VerificationStore.
- Same cases with extracted pre-repair verifier/root-boundary bodies:
  3 failed / 36 skipped, 4.123 s; whitespace was complete rather than repair,
  unsupported reason was generic and had no proper operational alert.
- `pnpm test:integration source/cli.integration.test.ts -t 'the shipped CLI verifies a durable goal' --reporter=verbose`
  — 2 passed / 53 skipped, 4.929 s. Existing assertions check exact worker versus
  fresh-verifier requests/tools, absence of worker sentinels, real Git repository,
  actual SQLite path/record, PASS and nonempty attested revision.
- Temporary built-CLI non-Git extension: 1 passed / 54 skipped, 3.223 s.
  The actual alert included reason `not-a-git-repository`, raw Git failure detail,
  exact workspace and task hash of workspace + persisted goal ID. Exit was 2;
  no verification DB existed, so no attested revision was claimed.
- Default-off non-vacuity control modified **only a separate disposable compiled
  CLI cache**, not tracked source/defaults. After both schema and fallback defaults
  were made false, a real SettingsService inspection printed
  `EDD_ACTIVATED_DEFAULT_OFF false`. Both cases then failed precisely
  “length of 4 but got 2” (6.737 s).

Retained setup failures: the first default mutation changed only fallback
defaults, leaving schema default true (2 tests green, ineffective control,
6.641 s); the activated inspection initially compared ANSI-colored console
output against raw `false` and stopped before CLI dispatch (4.838 s).
Machine-readable inspection corrected that without changing acceptance checks.

Unsupported CLI setup initially changed XDG_STATE_HOME without moving its
settings, so the local provider was not selected and child startup got HTTP 401
(4.329 s). A wrong config-directory hypothesis repeated that setup error
(4.028 s); reading settings-path.ts identified state-directory ownership.
The effective fixture was then pinned to the aligned state path and explicit
mock provider. A subsequent probe reached the intended alert but over-specified
raw Git detail wording (3.281 s). Correct named reason/output/identity assertions
were retained; raw detail is asserted as actual Git stderr, not invented copy.
No paid model experiment was conducted; usage/cost of unauthorized fallback
attempts was not observed and is not asserted to be zero.

## Controls, evidence and measurement

Historical **module-body controls on current dependencies**, not whole historical
binaries:

| Repair parent | Exact parent revision |
| --- | --- |
| `c778010c^` | `39420e0d4005db48010fbbab9395d7eb4eefb141` |
| `220fd838^` | `ad22e030c60df3757b7f519c80f581a2f7e118dc` |
| `635513c3^` | `001e0d806025197780714870681999d056330854` |
| `05f694cf^` | `7e9b8e601e5dae6a8001bec04f6aefac82ea4ec2` |
| `a1d0d623^` | `6498d1798a46c963e69d5d8f4090af53777db2d7` |

Logs, exact command argv, start times, observed command wall durations, source
identity, hashes, stdout/stderr, final probe-source text and sequence artifacts:
`/tmp/edd-acceptance-20261024/`. Machine-local evidence may expire; decisive
signatures are retained above; exhaustive former run records are archived at
`42724797:docs/test-results.json` (routine accounting was later retired).
Final-source archives are text evidence; temporary executable probes and
historical modules were removed from the checkout before commit.

All command durations are **verifier command wall time**, not active effort,
author effort, measured rework, or total task cost. Failed/ineffective attempts
remain in the index. Session IDs, tokens, monetary cost, active verifier/human
effort and original author completion/acceptance times are unknown. No zero
cost or surveillance interval is inferred. Acceptance timestamps describe this
new verdict, not original delivery.

No reachable production defect was demonstrated on the tested current source.
No production repair was made. Native macOS/Windows, full PTY rollover, all
logging errno variants, arbitrary execution-requiring verifier criteria and
long-term defect surveillance remain unverified. No broad suite result is used
to stand in for these targeted claims.
