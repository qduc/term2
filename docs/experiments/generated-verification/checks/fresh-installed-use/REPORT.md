# Queue lifecycle repair: fresh installed-command verification

Verdict: **REJECT merge-readiness acceptance — behavioral verification BLOCKED by sandbox.** No demonstrated production defect is alleged by this verdict. Required supported samples and fixed-snapshot failure replays could not execute.

## Snapshot and authority

Independently inspected repair `4de1cebf` and launcher/replay change `db1c1f88`, against parent `9288a02c`. Tested HEAD: `db1c1f884d663cb14cc90da9487683fc1afab6ac`; committed tree: `b72eccf32b942bfb1852f855e9d44d76965cbde4`. The checkout is dirty with pre-existing documentation/evidence changes; production, installed method, package manifest and lockfile match HEAD (`method-tracked-diff.txt` is empty). This is a dirty-checkout run, not a clean-commit run. Initial status is retained in `snapshot.json`; final status in `final-status.txt`.

Method: shipped `docs/experiments/generated-verification/README.md`, with repository verification/testing instructions and bounded independent code review. Exact SHA-256 hashes of method, checker files, production entry points, package/lock, installed dependency metadata, instructions and retained red artifacts are in `snapshot.json`. Node v24.19.0, pnpm 11.7.0; installed dependency versions are also recorded there. No dependency installation, source/checker changes, child agents, model/profile changes, Git monkeypatch, direct-helper substitution or permission bypass was used. Only new evidence in this directory was written. User write scope precludes updating the general test-results/experiment ledgers.

## Executed commands and outcomes

All commands ran from the repository root through **`pnpm verify:generated`**. `commands.json` contains exact argument arrays, exit codes, wall runtimes and finite subprocess timeouts. Each invocation has separate complete `.stdout` and `.stderr` files. No timeout fired. Total command wall time: 25.106 seconds. Checker `runtimeMs` is unavailable: successful property JSON was never produced.

| Invocation label | Exit | Wall seconds | Observation |
| --- | --- | --- | --- |
| help | 0 | 1.811 | PASS: usage printed |
| all-424242 | 2 | 1.554 | BLOCKED: Git subprocess denied before properties |
| bad-target | 2 | 1.857 | PASS: expected validation error |
| bad-property | 2 | 2.123 | PASS: expected validation error |
| bad-runs-zero | 2 | 1.928 | PASS: expected validation error |
| bad-runs-fraction | 2 | 2.286 | PASS: expected validation error |
| bad-seed-range | 2 | 2.071 | PASS: expected validation error |
| bad-seed-text | 2 | 1.752 | PASS: expected validation error |
| bad-path | 2 | 1.894 | PASS: expected validation error |
| bad-option | 2 | 1.696 | PASS: expected validation error |
| all-424242-rerun | 2 | 1.329 | BLOCKED: Git subprocess denied before properties |
| history | 2 | 1.312 | BLOCKED: Git subprocess denied before properties |
| queue | 2 | 1.446 | BLOCKED: Git subprocess denied before properties |
| original-serial-replay | 2 | 1.015 | BLOCKED: Git subprocess denied before properties |
| original-restore-replay | 2 | 1.032 | BLOCKED: Git subprocess denied before properties |

The first valid invocation was:

```sh
pnpm verify:generated --seed 424242 --output docs/experiments/generated-verification/checks/fresh-installed-use/all-424242.json
```

It failed at `scripts/generated-verification/run.mjs:46–47` while obtaining revision metadata via `execFileSync('git', ...)`: **`Error: spawnSync git EPERM`**. The installed loader starts successfully; help and validation do not reach that Git call. A separate identical-seed run, separate history/queue targets, and both literal retained replay commands all reproduced the same denial. No JSON output file exists; no passing cases, failed properties or shrinks can be claimed. This is infrastructure exit 2, not a counterexample exit 1. The stdout package-manager lifecycle message is retained separately from the useful stderr stack.

## Independent inspection

`reviewed.diff` retains the inspected production/launcher/method diff. The serial queue property imports the actual `QueueController`, drives its public command/event API, and checks FIFO identities, text, snapshots, active state and phase after every step against a serial reference model. Only executor dispatch is recorded at the driver boundary. Restoration uses the production constructor and persistence interface with valid in-memory records and checks payload/pause preservation plus fresh-work admission. These are generated in-process contracts, not disk persistence or full application journeys.

The repair centralizes the previous discard-only empty-pause release and adds it after removal and saved-pause restoration. Its guard acts only when phase is `paused` and retained queue length is zero. Nonempty pauses retain their reason; cancelling/running ownership is unaffected. Existing interrupted-active restoration already treats no retained work as idle. The change follows that established contract. No actionable correctness issue was found in this bounded inspection; inspection cannot replace execution.

The history property imports production `projectProviderHistory`; its generated complete-pair/orphan expectations match `dropUnpairedFunctionCalls`, and its non-mutation/idempotence assertions match the projector contract. Static inspection of the checker and invoked contracts found no AI/provider/network calls in these property paths. Because all sampled executions stopped before `fc.check`, this run does not dynamically establish production contract behavior or offline execution through the properties.

The retained serial red artifact has submit, submit, fail, remove as its minimized sequence, reporting `paused !== idle` at step 3. The restoration red artifact has `['failure', []]`, reporting `paused !== idle`. These are supported contract violations. Both literal `replay` strings were invoked unchanged at the fixed snapshot and retained here, but both were blocked before fast-check ran. Historical red artifacts identify the defect; their original dirty snapshots alone do not fully reconstruct the old tree, and their old results are not presented as fresh evidence. Current generator/lock hashes and fixed committed snapshot are retained for a future authorized rerun.

## Limits and disposition

Supported all-target sampling requested 1,000 cases per property, max sequence length 30, seed 424242; separate history used seed 20261024 and queue used int32 minimum. **Zero properties executed.** Eight invalid invocations correctly exited 2 with their specific expected diagnostics; help exited 0. Output non-overwrite behavior and successful output JSON remain unverified because Git failed first.

No static/integration/e2e/provider/full-tier ownership is claimed. Parallel interleavings, persistence failures, approvals, steering, transports, multi-call envelopes, ledger recovery and arbitrary malformed production input remain outside this method's documented scope. Independent inspection and a fresh rerun were performed, but parent acceptance's successful real-command behavioral gate remains unsatisfied. An authorized environment must run the installed sample and retained replay commands successfully at these method/source/dependency hashes before acceptance; this verifier did not bypass the sandbox.
