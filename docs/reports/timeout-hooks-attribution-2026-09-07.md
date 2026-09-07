# L6 shell-timeout and project-hook warning attribution

**Evidence window:** 2026-09-06 07:43:49 through 2026-09-07 07:43:49,
local UTC+7 (inclusive)

**Sources:** `~/.local/state/term2-nodejs/logs/term2-2026-09-06.log` and
rotations `.1` through `.15`, plus `term2-2026-09-07.log`.  The app-log
timestamps are local wall-clock timestamps.  The source records are JSONL;
counts below are counts of structured records, not counts of mentions in
prompts or command output.

## Executive accounting

| Record class | Count | Pre-merge | Post-merge | Provenance split |
| --- | ---: | ---: | ---: | --- |
| `log.message` / `Shell command timeout` | 15 | 11 | 4 | 10 test/development probes, 5 controlled timeout pilot processes |
| `hooks.hook_disabled` / `hook_disabled` | 25 | 9 | 16 | 5 worktree development startups, 20 primary-checkout startups |
| **Total** | **40** | **20** | **20** | **15 test/development, 5 controlled pilot, 20 primary-checkout runtime** |

The phase split uses the evidence-backed shell-timeout merge at
`2026-09-06 15:24:20 +07:00` (`c9162de43b85d3f74d41a6aa39282775cc3953c5`,
merge of `19e773071a051749ae31947b0b3c1bddef40fbe6`).  A record is classified
by its warning/settlement timestamp, not by when a long-running command was
launched.  This makes the 15:22:46 watcher settlement pre-merge even though it
used the later pilot value.

The five controlled pilot rows are live processes in isolated `/tmp` pilot
directories, not production watcher traffic.  “Primary-checkout runtime” is
deliberately not called production: the hook records have no session,
correlation, process, or cwd identity.  The logs prove that the other 20
startup events ran from `/home/qduc/term2`, but do not prove that they were
user-facing production sessions.

## Projection-artifact verification

The three supplied artifacts were inspected as data only; neither a command
from a projection nor a stray file was executed.

* `/tmp/timeout-warning-projection.tsv` exists and contains 15 rows.  Its rows
  contain the 15 timeout timestamps, event type, correlation where present,
  effective timeout, and the available post-M2 fields.
* `/tmp/project-hooks-disabled-projection.jsonl` exists but is empty.  This is
  consistent with the populated TSV being the 25-row hook projection rather
  than evidence of zero hook events.
* `/tmp/project-hooks-projection.tsv` exists and contains 25 rows.  Every row
  is `hooks.hook_disabled`, level `warn`, code `hook_disabled`, message
  `Public hook diagnostic Project hooks are disabled`, and source scope
  `project`.
* Independent bounded `jq` counting over the requested log set returned 15
  timeout records and 25 hook records.  Timeout grouping was: 20000 (1),
  30000 (1), 60000 (1), 120000 (6), 1800000 (2), 3600000 (2), 5600000 (1),
  and 7200000 (1).  All 25 hook message IDs are unique.
* Workspace checks found no files named `=` or `0)`.  No production source was
  changed and no full-suite command was run for this report.

## Shell timeout identities and dispositions

The identity column prefers the timeout correlation ID.  Post-M2 rows also
have a `callId` and `jobId`; the older rows do not.  “Confirmed deadline”
means the launch/settlement interval and effective budget establish expiry;
the warning label alone is not treated as proof of deadline expiry.

| # | Timestamp | Identity | Effective budget / mode | Context and bounded evidence | Phase | Disposition |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 2026-09-06 08:46:55 | correlation `a4ebc5c2-2701-4037-8e9d-822a59c3d3b0` | 120000 ms; pre-M2 fields absent | `pnpm test:related …`; started 08:44:55 and settled at the 120-second warning with `successCount: 0`, `timeoutCount: 1` | pre | **Confirmed deadline; test validation interrupted.** |
| 2 | 2026-09-06 09:20:30 | no correlation ID | 120000 ms; pre-M2 fields absent | `find`/`jq` provider-traffic inspection command; a development evidence probe, not a product workload | pre | **Timeout warning accounted; deadline mechanism not independently joinable** because identity and elapsed fields are absent. |
| 3 | 2026-09-06 10:49:03 | correlation `30248c29-fdc7-4131-82de-df3f5bc0cbf5`; session `subagent-shady-oat-638` | 120000 ms; pre-M2 fields absent | Focused `pnpm test -- …`; start 10:47:03, settlement at 120 seconds, `successCount: 0`, `timeoutCount: 1` | pre | **Confirmed deadline; test validation interrupted.** |
| 4 | 2026-09-06 11:10:05 | no correlation ID | 120000 ms; pre-M2 fields absent | `pnpm test`; full-suite development validation attempt | pre | **Timeout warning accounted; exact join/elapsed evidence unavailable.** It is not counted as a completed full-suite gate. |
| 5 | 2026-09-06 12:26:33 | correlation `0dd4bccb-358a-43ac-98cc-629aefe1b748`; sessions `b2799d1a-082e-44f6-9fcc-b913ae9ed3ff` and `subagent-punctual-wolf-697` | 20000 ms; pre-M2 fields absent | `jq` audit query for warning events; started 12:26:13 and settled at 20 seconds | pre | **Confirmed deadline; development/log-analysis probe interrupted.** |
| 6 | 2026-09-06 13:19:39 | correlation `134c4e59-e856-4da9-9ebf-1ed1670276f9` | 1800000 ms; pre-M2 fields absent | `watch-receipts.sh` on `/tmp/qduc/term2-nodejs/et-watch-pilot-zXIZRz`; first no-explicit-budget watcher, started 12:49:39 | pre | **Confirmed default deadline (red E1 reproduction).** The 30-minute default killed the watcher before the marker and explains replacement churn. |
| 7 | 2026-09-06 13:19:39 | correlation `31228aa0-ff90-4eee-8d08-b28fc9911027` | 1800000 ms; pre-M2 fields absent | Marker writer `sleep 1860 …` for the same controlled pilot; started 12:49:39 | pre | **Confirmed default deadline (red E1 reproduction).** The writer was killed about 53 seconds before its intended marker. |
| 8 | 2026-09-06 13:55:12 | correlation `1b469bd2-ed54-4ab1-bc9a-c83868658f4f` | 3600000 ms; pre-M2 fields absent | Gap-pilot watcher G1; started 13:55:05 and settled about 7 seconds later while being deliberately cancelled through its owner | pre | **Controlled cancellation mislabeled as timeout.** The warning does not establish deadline expiry. |
| 9 | 2026-09-06 13:55:50 | correlation `014954af-119a-4fc2-bfa8-055eddd93835` | 3600000 ms; pre-M2 fields absent | Gap-pilot watcher G2; started 13:55:35 and settled about 15 seconds later after deliberate cancellation | pre | **Controlled cancellation mislabeled as timeout.** The warning does not establish deadline expiry. |
| 10 | 2026-09-06 15:22:46 | correlation `8592a0bb-40e1-4f9f-a072-20f00b8ec5ab` | 7200000 ms; pre-M2 fields absent | Controlled watcher started 13:22:46 on `et-watch-pilot-zXIZRz`; settled exactly two hours later. The closed plan receipt records typed `timed_out`, one instance, and marker delivery after minute 30 | pre | **Expected explicit-horizon settlement.** This is evidence that the selected finite pilot value worked; the warning itself lacks typed reason because it predates the merged logging fields. |
| 11 | 2026-09-06 15:23:09 | correlation `db0194ec-db3e-4d61-b362-a2ee37aa3772` | 5600000 ms; pre-M2 fields absent | `for i in 1 2 3; do sleep 1800 …`; development/cache-warm probe started 14:04:49 and settled after about 4700000 ms, before its configured horizon | pre | **Not a confirmed deadline.** The timeout label and `timeoutCount` are present, but elapsed/source/reason are absent and the process ended before 5600000 ms. |
| 12 | 2026-09-06 17:26:22 | correlation `552ca3d7-9f41-4fae-9851-55d5ed16517b`; `callId` `call_26861b5ade5b4d3eb2887f2b`; `jobId` `1f3927e8-2bd3-470f-bee7-45a1aeea56c6` | 60000 ms; invocation; foreground; elapsed 60006 ms | Model-flag-picker development command; settlement has `terminationKind: deadline`, `successCount: 0`, `timeoutCount: 1` | post | **Confirmed deadline with M2 attribution.** Explicit 60-second validation budget was enforced. |
| 13 | 2026-09-06 17:26:30 | correlation `5db0567a-5a6e-4a14-a3d0-fb0001cb1116`; `callId` `call_edcc511824d0422f8283c334`; `jobId` `9de2b506-4b2c-4dba-a56e-dad0cd4bfac4` | 120000 ms; foreground setting; foreground; elapsed 37–38 ms | `pgrep`/`pkill` development process-control command; settlement has `timeoutCount: 1` but no `terminationKind` and elapsed is far below the 120-second budget | post | **Attribution anomaly, not a confirmed timeout.** The command likely disrupted its own supervision path; preserve as an M2 observability gap rather than inflating deadline incidence. |
| 14 | 2026-09-06 19:47:41 | correlation `be1d4acc-c407-4a86-a752-ff9764a77a6f`; `callId` `call_Ij7meNbtg4oglKWVpvoZUJK4`; `jobId` `7031e440-f564-4e6f-928b-e2219cb1fd27` | 120000 ms; invocation; foreground; elapsed 120067 ms | Prettier development command; settlement has `terminationKind: deadline`, `successCount: 0`, `timeoutCount: 1` | post | **Confirmed deadline with M2 attribution.** Explicit 120-second formatting budget was enforced. |
| 15 | 2026-09-06 19:48:37 | correlation `f4aa7d1e-56f0-48a6-a438-35330c78cd40`; `callId` `call_hE1vvaqNyNYryH2VsMM7Z1ta`; `jobId` `cb2a6984-09a9-44f7-86b8-3889c7c7c722` | 30000 ms; invocation; foreground; elapsed 30092 ms | Focused `pnpm test source/components/input/ModelMenuSession.test.tsx`; settlement has `terminationKind: deadline`, `successCount: 0`, `timeoutCount: 1` | post | **Confirmed deadline with M2 attribution.** Explicit 30-second test budget was enforced. |

### Shell evidence summary

The pre-M2 set contains 11 rows: five ordinary validation/log-analysis
probes, five controlled pilot watcher/writer rows, and one cache-warm probe.
The two 1,800,000 ms rows are the direct red proof of the old background
default. The 3,600,000 ms rows ended after seconds by deliberate cancellation,
not deadline expiry. The 7,200,000 ms row is the intended two-hour pilot
settlement and is independently described in the closed plan receipt.

The post-M2 set contains four development rows. Three have joinable
`callId`/`jobId`, source, mode, elapsed time, and `terminationKind: deadline`.
The fourth has the source and mode but no termination kind and an elapsed time
of 37–38 ms against a 120,000 ms budget. This is a confirmed attribution gap,
not evidence that the 120-second guard fired.

## Project-hook warning identities and context

Each hook row is a distinct event: `code: hook_disabled`,
`eventType: hooks.hook_disabled`, `level: warn`, and
`source.scope: project`. The warning records themselves have no correlation ID,
trace ID, session ID, or command. Startup-side `Skill name collision` records
at the same timestamp provide the bounded path context below; they are not
counted as additional hook warnings.

### Pre-merge (9)

| Timestamp | Message ID | Startup context | Classification and disposition |
| --- | --- | --- | --- |
| 07:49:38 | `msg-1788655778838-kfxo8m` | `/home/qduc/term2` | Primary-checkout runtime; project hooks-disabled diagnostic, not a shell timeout. |
| 08:04:26 | `msg-1788656666026-hp6a6u` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 08:29:59 | `msg-1788658199519-mcpbxp` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 08:33:23 | `msg-1788658403799-fdm99q` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 08:42:03 | `msg-1788658923322-nco6yb` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 12:16:10 | `msg-1788671770344-3r89lk` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 12:19:25 | `msg-1788671965756-hmcxo4` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic. |
| 14:53:56 | `msg-1788681236835-ngy895` | `/home/qduc/term2/.worktrees/model-nicknames` | Unambiguously development worktree startup; same diagnostic. |
| 15:23:37 | `msg-1788683017322-mjmasg` | `/home/qduc/term2/.worktrees/model-nicknames` | Unambiguously development worktree startup; 43 seconds before the timeout-fix merge. |

### Post-merge (16)

| Timestamp | Message ID | Startup context | Classification and disposition |
| --- | --- | --- | --- |
| 16:30:18 | `msg-1788687018236-0e05os` | `/home/qduc/term2/.worktrees/rc-contract-repair` | Unambiguously development worktree startup; same diagnostic. |
| 16:48:43 | `msg-1788688123582-x74zt8` | `/home/qduc/term2/.worktrees/model-picker-cli` | Unambiguously development worktree startup; same diagnostic. |
| 16:52:31 | `msg-1788688351338-th7nyb` | `/home/qduc/term2/.worktrees/rc-contract-repair` | Unambiguously development worktree startup; same diagnostic. |
| 17:07:17 | `msg-1788689237750-neidcn` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 17:11:15 | `msg-1788689475511-5itil8` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 17:12:34 | `msg-1788689554693-zj0oxd` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 19:19:05 | `msg-1788697145938-bq0ehc` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 19:24:02 | `msg-1788697442741-hg4in3` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 19:39:57 | `msg-1788698397789-j8sk2n` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 20:23:12 | `msg-1788700992103-7hw881` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 22:02:36 | `msg-1788706956099-59o4dq` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 22:34:54 | `msg-1788708894759-396irt` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 23:35:24 | `msg-1788712524914-grayuz` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 23:59:17 | `msg-1788713957127-lnfx0u` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 2026-09-07 00:03:10 | `msg-1788714190680-fvn6lf` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |
| 2026-09-07 07:42:44 | `msg-1788741764744-r9ja6m` | `/home/qduc/term2` | Primary-checkout runtime; same diagnostic, no production identity in record. |

### Hook interpretation

The warning is a startup/configuration diagnostic, not evidence that a hook
failed, a shell command timed out, or a project action was lost. Its frequency
tracks application/worktree startups: five rows have explicit development
worktree paths and 20 have the primary checkout path. There is no supported
join from any hook row to any of the 15 timeout correlations, so attributing a
hook warning to a particular timeout would be incorrect. The increase from
9 pre-merge to 16 post-merge is therefore startup mix, not a regression or a
timeout-fix effect.

## Confirmed improvements versus expected status

### Confirmed and consistent with the closed plan

1. The two no-explicit-budget 1,800,000 ms pilot expiries reproduce the E1
   mechanism directly. The later two-hour explicit watcher survived the old
   30-minute background default, delivered its post-minute-30 marker, and
   reached its chosen finite horizon without replacement, as recorded in the
   closed plan receipt.
2. The merged M2 executor fields are actionable on three post-merge deadline
   rows: invocation versus setting source, effective budget, foreground mode,
   elapsed time, call/job identity, and typed `deadline` settlement are
   joinable without provider request bodies.
3. Deliberate cancellation remains distinguishable in the closed plan's pilot
   receipt, even though the two pre-M2 warning labels were the generic
   `Shell command timeout` label. This prevents those short controlled runs
   from being counted as deadline incidents.
4. The evidence supports no default, cap, renewal API, detachment, or persisted
   setting change. The configured 120,000 ms foreground and 1,800,000 ms
   background defaults remain the contract described by the closed plan.
5. The project-hook diagnostic remains correctly scoped to `source.scope:
   project`; there is no evidence in this window that the timeout work changed
   hook behavior.

### Remaining confirmed gaps or expected follow-up

* Eleven pre-M2 timeout records lack the new source/mode/elapsed/typed-reason
  fields, and two lack a correlation ID. They can be counted and, where exact
  timing permits, classified, but cannot be joined as richly as post-M2 rows.
* Post-M2 correlation `5db0567a-5a6e-4a14-a3d0-fb0001cb1116` has
  `timeoutCount: 1` despite 37–38 ms elapsed against a 120,000 ms setting and
  has no `terminationKind`. It needs diagnosis if this process-control pattern
  recurs; it does not justify raising a default or weakening containment.
* The hook event contract does not carry startup identity. If future attribution
  needs a production/development distinction, add a bounded owner identity at
  the startup boundary rather than inferring it from warning count. No such
  production change is made by this report.
* The closed plan's stated post-merge harness verification that cancelled
  background notifications render `cancelled` rather than `timeout` remains a
  separate expected follow-up. It is not inferable from these 25 hook rows and
  was not run here.

## Reproduction and scope boundary

This report is an evidence receipt only. It performs no replay, retry, timeout
extension, cap/default increase, production edit, full-suite run, or execution
of command payloads found in logs. The report accounts for all 15 timeout and
all 25 project-hook records found by the bounded structured query; the only
identity gaps are the two timeout rows whose source logs themselves have no
correlation ID, plus the pre-M2 rows whose executor metadata was not yet
logged.
