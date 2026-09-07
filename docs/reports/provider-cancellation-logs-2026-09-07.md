# Provider cancellation logging evidence and repair

## Scope

This report covers the provider traffic logger, the HTTP fetch logging path
that delegates to it, and `CodexResponsesWSModel` stream accounting. It does
not change retry, chaining, compaction, UI, or conversation recovery policy.
The canonical coordination record is
`docs/plans/log-friction-improvements-2026-09-07.md`; its evidence window is
2026-09-06 07:43:49 through 2026-09-07 07:43:49 local UTC+7.

## Evidence found

The provider-traffic request artifacts contain three Codex cancellation
failures in that window. Each is a `gpt-5.6-luna` request in session
`d27dc356-4eda-4882-9c38-80d8aa46cdbd`, with zero frames received and an
explicit `errorKind: "cancelled"`:

| Local app time | Provider timestamp | Request ID | Traffic artifact |
| --- | --- | --- | --- |
| 2026-09-06 09:07:58 | 2026-09-06T02:07:58.504Z | `137df9b4-c34e-4afc-b601-5f96c20641b9` | `provider-traffic/2026-09-06/01-59-40_d27dc/02-07-58.142Z_137df.json` |
| 2026-09-06 09:44:07 | 2026-09-06T02:44:07.756Z | `9a042ee5-ad32-44b2-b304-10371cdbde78` | `provider-traffic/2026-09-06/01-59-40_d27dc/02-44-05.686Z_9a042.json` |
| 2026-09-06 10:53:31 | 2026-09-06T03:53:31.530Z | `f732fbdd-c53b-4614-8777-1e132463c35b` | `provider-traffic/2026-09-06/01-59-40_d27dc/03-53-29.900Z_f732f.json` |

The corresponding app records are `provider.response.failed` at error level
with message `codex request failed` in rotations
`term2-2026-09-06.log.6`, `.7`, and `.8`, respectively. The provider artifact
already retained the request and cancellation classification; the defect was
the provider logging level/event, not missing wire evidence. Counts here are
records, not unique user incidents.

The records were recovered with a provider-artifact projection over
`received.provider`, `received.error.errorKind`, and the UTC timestamp, and an
app-log projection over `eventType`, `provider`, `errorKind`, `requestId`, and
the local timestamp. The app and provider timestamps differ by the documented
UTC+7 offset.

## Repair

- `ProviderTraffic.recordRequestFailed` now uses the strict
  `isClassifiedCancellation` predicate. A pure explicit abort is retained in
  the provider artifact but logged as debug `stream.aborted` with phase
  `abort`; concrete provider/network failures stay error
  `provider.response.failed`.
- The error branch of `ProviderTraffic.recordResponseReceived` follows the
  same rule for body-read failures.
- `CodexResponsesWSModel` only chooses its retained `aborted` close outcome
  when the thrown failure is a strict cancellation. If an abort races a
  concrete status/network failure, it stays on `recordRequestFailed` with
  bounded progress diagnostics.
- The HTTP fetch middleware remains the delegation boundary; its regression
  test exercises the real middleware plus `ProviderTraffic`, proving that an
  explicit fetch abort receives the provider abort telemetry without changing
  the original thrown error.

Wire artifacts are not suppressed or deleted. Mixed `AggregateError` trees
and aborts wrapping concrete failures are deliberately excluded from the
strict cancellation branch and continue to use the failure event.

## Validation receipts

All commands ran in the isolated `provider-cancel-logs` worktree after
`pnpm install` (pnpm 11.7.0).

| Command | Result | Count / elapsed |
| --- | --- | --- |
| `pnpm test source/services/logging/provider-traffic.test.ts source/providers/fetch/composer.test.ts source/providers/codex-responses-model.test.ts` (baseline) | pass | 171 tests, 3 files; Vitest 0.714s, shell 2.708s |
| `pnpm test source/services/logging/provider-traffic.test.ts` (test-only red proof before implementation) | fail as expected | 46 passed, 2 new failures; Vitest 0.397s, shell 2.408s |
| same three-file focused command after implementation | pass | 174 tests, 3 files; Vitest 0.768s, shell 2.789s |
| `pnpm test source/services/retry/provider-failure-classification.test.ts source/services/logging/provider-traffic.test.ts source/providers/fetch/composer.test.ts source/providers/codex-responses-model.test.ts` | pass | 182 tests, 4 files; Vitest 0.862s, shell 2.922s |
| same four-file focused command after parent-review follow-up coverage | pass | 186 tests, 4 files; Vitest 1.05s, shell 3.152s |
| `pnpm typecheck` | pass | shell 8.953s |
| `pnpm typecheck` after parent-review follow-up coverage | pass | shell 5.289s |
| `pnpm test:provider-black-box` | pass | 177 passed, 1 skipped, 20 files; Vitest 84.87s, shell 93.979s |
| `pnpm test:changed` | fail (failure attribution unverified) | 3294 passed, 22 failed, 2 expected fail, 2 skipped; Vitest 78.28s, shell 98.718s |

## Unknowns and boundaries

- These historical records predate this repair; no live provider replay was
  used, and the fix does not claim that the three cancellations were user
  initiated rather than another controlled abort.
- The broad `classifyProviderFailure` result can still say `cancelled` for a
  mixed tree because that classifier serves retry policy. Logging decisions
  intentionally use the stricter explicit-marker predicate, so a mixed tree
  remains an error event even when its broad `errorKind` field is cancelled.
- The provider black-box gate covers Codex/OpenAI HTTP and WebSocket failure
  lifecycles, but it does not assert application log severity for a live user
  cancellation; the deterministic unit regressions own that contract.
- The `pnpm test:changed` failure set was not compared by exact test identity
  with the main-worktree baseline (the available baseline receipt records 20
  failures). Its 22 failures therefore have unverified attribution: this
  report does not claim they were pre-existing or classify any extra failures.
  The focused provider gate above is the relevant green gate for this diff.
