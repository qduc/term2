# Daemon Step 14e–14f orchestration: retrospective

One orchestrator session on 2026-11-28 worked [the singleton daemon plan](../plans/daemon/README.md)
from Step 14e Part 1 towards the Step 14f flip, mostly through subagents in
separate worktrees, each checked by an independent verifier. This records what
went wrong and why, so the next run of this kind avoids it. Facts are as of
`main` at `d60623817`.

## Outcome

- Landed:
  - [qduc/term2#477](https://github.com/qduc/term2/pull/477): Step 14e Part 2,
    control socket, Discord and ACP over the daemon (D011).
  - [qduc/term2#478](https://github.com/qduc/term2/pull/478): worth-revisiting
    item 17, launch values scoped to their own session.
- Closed unmerged: [qduc/term2#476](https://github.com/qduc/term2/pull/476),
  a Part 1 that duplicated the already merged
  [qduc/term2#475](https://github.com/qduc/term2/pull/475).
- Unfinished when this was written:
  - item 18 (resume of a live session keeping an earlier posture), on its fifth
    attempt;
  - three bug fixes for `main` extracted from the flip branch, under
    verification;
  - the Step 14f flip, parked: 24 e2e and 15 provider black-box cases failed
    only in daemon mode, and those lanes ran 2–3.5× slower than the 120 s budget.

## What worked

- **Independent verifiers.** Every rejection named a real defect, most of them
  posture weakenings the authors' own tests missed. Examples: write tools
  carried across serve leases, ACP MCP processes outliving their editor, the web
  session-config route bypassing the per-RPC ACP guard, and a resume running
  looser than it asked.
- **Red proofs against the built CLI.** Disabling each fix in the bundle and
  watching its test fail caught tests that were green for the wrong reason. A
  lease carry-over test passed with its fix removed because the host releases an
  unattached session on its own; only a live attachment made the case real.
- **Parallel worktrees with stated file ownership.** The control-socket and ACP
  halves of Part 2 were built side by side and merged with small additive
  conflicts in `daemon.ts`, `daemon-rpc-v11.ts` and one conformance test.

## What went wrong, and why

1. **Duplicated merged work.** #475 merged Part 1 at 04:54 UTC, before this
   session wrote any code for it. The session trusted the plan's "Resume here"
   and never checked `origin/main` or recent PRs. Cost: a whole Part 1, plus
   porting two Part 2 subagents from that base onto #475's layout.
2. **A stuck PR went unnoticed for about 45 minutes.** #476 had a merge conflict
   (`mergeable_state: dirty`), so no CI run started. "No checks yet" was read as
   slow CI.
3. **Concurrency fixes introduced new defects twice.** A fix for a shutdown race
   in the serve lease leaked the HTTP listener when a client disconnected
   mid-start. The fix for that leak, `DirectServerTransport.stop()` waiting for
   an in-flight `start()`, deadlocked when `start()` failed, because start's own
   cleanup called `stop()`. Neither change began from a written list of the
   interleavings it had to survive.
4. **Red proofs aimed at the wrong file.** The built CLI, and any daemon it
   auto-starts, runs `dist/src/app/cli.bundle.cjs`. Patching
   `dist/src/**/*.js` changed nothing, so the test stayed green and looked like
   a test that could not catch its bug. Three runs were wasted; the trap is now
   in the `testing` skill.
5. **Subagents shared one scratch folder.** One overwrote another's bundle
   backup during a red proof, so the ACP author's first proofs had to be
   re-derived by the verifier.
6. **Item 18 took five attempts.** See the next section.
7. **A test run changed `/tmp` to mode 0700.** The flip subagent pointed a
   conversations directory under `/tmp`. `resolveDaemonPaths` on `main` then
   used that directory's parent as the daemon state directory, and
   `ensureSecurePrivateDir` changed its mode. The agent restored `/tmp`, and the
   underlying bug is one of the extracted fixes. The brief had said "isolate
   tests" without naming shared parent directories as off limits.

## Why item 18 took five attempts

The user-visible bug (`--auto-approve`, then a plain `--resume last` keeping
auto-approve) was fixed by attempt 1 and held from then on. The later rounds came
from two causes:

| Attempt | Verifier found | Origin |
| --- | --- | --- |
| 1 | Launch→attach race; approval mode and sandbox not compared; in-TUI `/resume` bypassing the check | Race introduced; the other two already on `main` |
| 2 | A launch loosening a session another client holds; reconnect landing on a looser session; a reservation left by a failed attach | First already on `main` (newly reachable); other two introduced |
| 3 | Posture held, but reconnect broke mid-turn and a tighter resume was refused at attach | Introduced |
| 4 | A resume running looser than asked, again | Introduced |

- **Scope grew.** Each review found adjacent gaps already on `main`, and they
  were folded into item 18 instead of being filed separately. Item 18 became a
  redesign of how the daemon decides a session's approval posture.
- **No single definition of the posture in force.** A daemon session's approval
  mode can come from its launch record, its live session settings, its
  configured settings, and whether it has been rebuilt since. Nothing named
  which one approvals actually follow. Attempts compared against different
  sources, fixed the reported cases, and broke cases that relied on another
  source. Attempts 3 and 4 failed for exactly that reason.
- **The orchestrator kept relaying patch lists.** After the second rejection the
  pattern was visible, but each round still went back to the author as a list
  of findings, not as a design question. A round cost about 25 minutes of
  authoring and 12 of verification.

## Rules for the next run

- Before starting a plan step, `git fetch origin main` and read recent and open
  PRs for that step. Do it again before opening a PR, and check the new PR's
  `mergeable_state` at once. The owner can run more than one session on the
  same plan.
- Before fixing concurrent code, list the interleavings to rule out, including
  the error paths of the fix itself, and test each one.
- Prove tests red by patching `dist/src/app/cli.bundle.cjs`, then restore it and
  confirm with `cmp`. Give every agent its own scratch folder.
- After two rejections in one area, stop patching. Write the invariant (here:
  one function for the posture in force, read by every check and every apply),
  get it reviewed, then fix. File adjacent pre-existing gaps as their own items
  rather than widening the one in hand.
- In agent briefs, name the dangerous side effects explicitly: shared parent
  directories, `/tmp`, `$HOME`, and the real daemon runtime directory.

## Corrections made during the session

- An early summary called the daemon's local-session `shellEscapeApproval` and
  `preserveSandboxedShellApproval` flags a review bypass. They failed closed: a
  person's plain approval of an unsandboxed command was refused, because the
  escape path required an explicit `unsandboxed-once` grant.
- Item 18 was once described as on its sixth round; it was the fifth attempt.

## Follow-ups not yet done

- When closing #476, the session promised to check whether its verifier's
  findings reproduce against #475's design. The likeliest one: web sessions from
  one serve state directory reaching another's through the shared `host` grant
  id.
- The TUI settings projection reports a stale `rebuilt: false` after another
  client's configure. It was found while verifying item 18 and is not yet a
  worth-revisiting entry.
