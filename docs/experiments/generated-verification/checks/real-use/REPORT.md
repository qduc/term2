# Independent integration review: REJECT

Reviewed final artifact `db1c1f884d663cb14cc90da9487683fc1afab6ac` against
`6075a3cf1507a050baf690240b89fc776cd2aedc`, including the initially dirty queue
repair (subsequently committed as `4de1cebf`). One installed-workflow blocker
remains. No supported queue repair or generated-oracle correctness defect was
found in the inspected scope. Parent owns acceptance and integration.

## Merge blocker R1: metadata collection prevents installed use in the managed workspace

Location: `scripts/generated-verification/run.mjs:46–48`.

Reproduction on the final artifact, with dependencies installed:

```sh
pnpm verify:generated --seed 424242
```

Expected: run the three sampled properties and exit 0 with their JSON report.
Observed: exit 2, `Error: spawnSync git EPERM`, before any property executes.
`final-plain-command.json`, `final-plain.stdout`, and `final-plain.stderr` retain
the exact uninstrumented command, elapsed time, and failure. The network-denied
repeat has the same failure (`unshimmed-commands.json`, `final-unshimmed.stderr`).
`--help` succeeds. This is a reachable installed workflow failure in this actual
managed host, rather than a false property or missing dependency. The earlier
CLI IPC failure was fixed by `db1c1f88`; this separate synchronous-process
restriction remains.

Discriminating probe: the same Node process receives `EPERM` from
`execFileSync('git', ['rev-parse', 'HEAD'])` but succeeds with promisified
`execFile('git', ['rev-parse', 'HEAD'])`, returning the exact reviewed HEAD.
See `git-sync-vs-async-command.json` and its stdout/stderr. Python Git subprocesses
also work, and the checker runs when only its two Git metadata responses are
supplied externally. The workspace and properties are usable; the synchronous
metadata subprocess is the obstacle.

Simplest adequate fix: await asynchronous `execFile` for both Git metadata queries.
Retain their failure handling, revision and dirty reporting. Verify the installed
command without the metadata shim, plus failure replay and exit codes.
Proportionality: first considered removing/narrowing metadata collection or
restricting documented use to another host. Removing it weakens reproducibility,
and excluding this working development host leaves the requested actual-user
workflow broken. Two asynchronous queries replace the existing two synchronous
queries; no retry, fallback, extra abstraction, or new guard is needed. No production
queue change is requested. Priority: merge-blocking acceptance failure, limited to
checker execution, with no demonstrated product data loss.

## Method, identity and immutable evidence

I used the shipped `docs/experiments/generated-verification/README.md`, repository
verification/testing skills, and code-review skill; read global/repository AGENTS,
the experiment contract and queue-editing ownership documentation. No children,
model/profile changes, checker edits, production edits, full-tier runs, or network
research. All writes are under this real-use evidence directory. Identity:
independent Codex agent `/root`, session/thread `01a16d3b-c693-7720-a3e7-d0823d4e24ca`;
model name/profile not exposed, no override. Node `v24.19.0`, pnpm `11.7.0`, Linux
`7.0.14-17-pve`.

`identity.json` records the initial snapshot; `final-identity.json` records final
SHA-256 hashes. Key final hashes:

| Artifact | SHA-256 |
| --- | --- |
| Shipped method README | `5845c6bf41631c048b675c2209bd02846edd25301e7450f587231264b8812f3f` |
| Checker runner | `3e43906067fb5920969f8580bab64cef20ea932c2a93bb718c5b85b43954b151` |
| Queue properties | `5a67e2ffe91006a5bdb92d4a3bda215a46ca4af09a7c056c46456da843beec71` |
| History property | `105aa5c60502c50eeb6f1a38147759aa7bde6e389c253283f8634e7e8d4c3f14` |
| Queue controller | `4080f03c7f8317e96ec425a5254766c7fbb5bf66defcb1ead41058735b9ef5f1` |
| Lockfile | `f9b0e87783a46e0c66aed30a35c79073e8b3d915331ffef8d1f289331c02fd6f` |

`reviewed.diff` and `final-reviewed.diff` retain the relevant base comparisons.
The controller hash stayed constant through the repair commit. The runner/package
and method changed during review; I inspected that delta and repeated the CLI
checks against the final hashes. The final source/checker/method README hashes were
rechecked after execution and matched. PLAN.md received concurrent parent progress
updates; `completion.json` records that separate documentation drift. Evidence-tree writes mean reports are
explicitly dirty snapshots, not clean-commit verification. Baseline-substitution
reports still identify the current runner revision; **they are not whole-base
runs**. `base-loader.mjs` resolves only the controller import to `base-queue.ts`,
the exact `git show 6075a3cf:source/services/queue/queue-controller.ts` content.

## Executed evidence and behavior

`commands.json` records exact argv, environment instrumentation, exit and wall time
for 19 final installed-command invocations. Every stdout/stderr file is retained.
They use the unmodified installed package command. **Except the explicitly plain
and unshimmed runs, these commands supply captured Git metadata using
`git-metadata-loader.mjs` to get past R1. This is diagnostic evidence, not an
installed-workflow pass.** `git-metadata.json` retains the externally captured
values. The shim intercepts only the two exact metadata queries; it does not
change generators, fast-check, assertions, production APIs or outcomes.

| Command arguments after `pnpm verify:generated` | Expected / observed with metadata supplied |
| --- | --- |
| `--seed 424242` | 0; 1,000 cases each of history, restore, serial pass; 600ms checker / 2.116s wall |
| `--target history --runs 1000 --seed 123456` | 0; 1,000 pass; 525ms / 2.240s |
| `--target queue --runs 10000 --seed 8675309` | 0; 10,000 per queue property pass; 791ms / 2.486s |
| `--seed=-2147483648 --runs 100` | 0; 100 per property pass; 86ms / 1.718s |
| `--help` | 0; usage present (also passes without metadata shim) |
| Bad target, property, runs 0, out-of-int32 seed | 2; explanatory errors |
| Replay path without property; invalid path | 2; explanatory errors |
| Recorded serial and restore replay paths on repaired source | 0; properties pass |
| `--output` to new file | 0; structured JSON saved |
| Same output path again | 2; EEXIST, original file retained |

The 1,000-case seed-424242 baseline-controller run exits **1**, not 2, and independently
rediscovers both genuine supported defects:

- Restore: case 7, one shrink, path `6:0`, counterexample `['failure', []]`;
  baseline reports paused instead of idle.
- Serial: case 314, 22 shrinks, path
  `313:1:2:2:2:2:2:2:2:2:2:5:5:5:5:5:5:5:5:8:8:11:11`;
  submit, submit, fail, remove leaves an empty paused queue.

Both recorded paths reproduce on the exact baseline controller (one case each,
exit 1) and pass on the repaired controller. Negative seed `-2147483648` also
finds the empty-restore defect (case 1, one shrink, path `0:0`). Executing its
**actual emitted replay command**, including `--seed=-2147483648`, reproduces
exit 1: `base-negative-replay-command.json` and stdout/stderr. Thus seeds,
shrinking, replay selection and counterexample failure exits are live mechanisms.

The permanent properties import and run the production projection/controller.
The serial oracle owns its own FIFO state and observes queue/active/phase and
actual driver starts at every step. Execution IDs have an independent monotone
counter, stale completions use a real previously completed execution when one
exists, and starts compare the snapshot text as well as item text. History
asserts input non-mutation, exact complete-pair retention/orphan exclusion and
idempotence for the supported Responses-style space. Saved pauses use the
production record validator/restore path. No mocked production outcome or
LLM-generated oracle participates.

The separately authored `boundary-probe.mjs` runs directly through Node's tsx
import loader, with **no Git metadata shim**. Its retained `boundary.stdout`
reports **21/21 passing**, exit 0. It covers all three saved pause reasons with
0/1/3 items, exact supported payload/id/sequence/date retention, no restore replay,
fresh input and resume ordering, actual filesystem persistence and reconstruction
after deleting the last failure item, partial deletion retaining failure reason,
and edited dispatch snapshot isolation with issued-ID stale completed/failed events.
Nine cancellation cases cross 0/1/3 retained items with no mutation/removal/discard:
`cancel` returns false, further submissions/resume/stale proof and even matching
terminal events cannot release ownership; only matching `cancellation_settled`
can release it. Retained work stays manually paused; with no retained work fresh
input starts; repeated old proof cannot alter the next execution.

Exact boundary command:

```sh
NODE_OPTIONS="--import $(pwd)/docs/experiments/generated-verification/checks/real-use/network-deny.mjs" node --import tsx docs/experiments/generated-verification/checks/real-use/boundary-probe.mjs
```

Initial probe failures were my oracle/setup mistakes, retained in
`initial-probe-boundary.*`: a wrong relative import, comparing absent optional
`preflight` against the production explicit `undefined` representation, and
expecting the factory's original snapshot to be frozen when production correctly
clones it. Corrected probe asserts preservation of supported values and isolation
of the production clone, without weakening a production contract. No source fix
was needed for these false candidates.

`network-deny.mjs` blocks TCP/TLS/HTTP(S), DNS, datagrams, fetch and WebSocket,
while allowing the harness's local Unix-domain IPC. Final checker, baseline,
replay and boundary runs record **zero attempted network calls**. Static imports
contain production APIs and fast-check; no provider/model calls are invoked.
An initial guard also blocked local IPC; that instrumentation mistake is retained
under `overbroad-guard/`, not counted as a product failure. The independent plain
installed failure proves R1 does not depend on the guard.

## Costs, limits and integration action

Final 19-command evidence series took about 32 seconds wall in aggregate, with
under one second of checker time per measured target; this includes subprocess
startup and the metadata diagnostic shim. Review/diagnosis effort is roughly
10–15 minutes, including this report; exact total/token/model cost unknown. No AI
or provider spend during checker/probe execution. No speedup comparison claimed.

This is bounded installed developer opt-in sampling, not exhaustive or formal
verification. No evidence is claimed for parallel command interleavings,
persistence failure, steering, approvals, provider transports, ledger recovery,
multi-call chat envelopes, malformed arbitrary history, or the actual Ink UI.
Cancellation probes cover false-return proof/identity semantics, not arbitrary
throwing custom drivers or concurrent cancellation. Tracing the adapter confirms
real ID-addressed queue removal and matching-proof consumers; the scope does not
hide the actual queue consumer. The actual driver start remains the deliberately
external executor boundary.

I did not rerun full tiers or alter unrelated shell safety policy; parent owns
those running results and the known reproduced baseline CLI failures. No verdict
on those unexecuted tiers is inferred here. No ledger outside this permitted
evidence directory was modified. Temporary `.mjs` and baseline `.ts` probe sources
are archived as `.txt` after execution so they do not become a permanent example
suite or enter repository lint/typechecking. To rerun this diagnostic evidence,
materialize each `*.mjs.txt`/`*.ts.txt` under its original name in this evidence
directory, run the retained Python harness, then remove the materialized sources.
`commands.json` records the exact names and commands that actually ran. The earlier
broad lint job saw these temporary files while review was active; parent should
rerun lint after this archival cleanup. No blanket lint ignore was added.

Decision: **REJECT ready-for-merge status until R1 is fixed and the final installed
command runs successfully without metadata substitution in this workspace.** The
queue repair and generated properties have affirmative independent behavioral
evidence; they do not need additional runtime mechanism. Parent should inspect
this report, make the small metadata collection change, rerun the installed and
replay/exit checks, and combine that evidence with the separately owned full-tier
results before acceptance.
