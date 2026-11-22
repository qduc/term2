# Headless approval redesign: modes, presence, floor, scratch, credentials

Owner decisions of 2026-11-22. They settle the three items held in
[support-tier-gaps.md](../engineering/support-tier-gaps.md) ("Held 2026-11-22"):
credential files a sandboxed command can read, headless `--auto-approve`
writing outside the workspace, and the `/tmp` redirect with the sandbox off.
The current policy is described in [approval-arbiter.md](approval-arbiter.md);
the unattended snapshot and refusal rules in
[unattended-approval.md](unattended-approval.md).

Status: decided, build in progress. Each part below lands as its own PR, in
the order of the build list. No part is merged yet.

## The problem

Two policies answer "what may run without a person approving it":

1. The mode's route (`approvalRouteFor` in `src/session/approval/approval-route.ts`)
   with the reviewer (`approval-arbiter.ts`).
2. In headless runs, whatever the route would hand to a person goes to
   `NonInteractiveApprovalPolicy` (`src/session/approval/non-interactive-approval-policy.ts`)
   through `decideInteraction` in `src/app/tool-surface.ts`. Without
   `--auto-approve` it denies. With it, it classifies shell commands and
   allows every other tool unconditionally.

The second policy predates `unattended` and understands only the shell. That
is how an outside-workspace `create_file` the reviewer had rejected in `auto`
was still allowed headlessly, including into `.term2/hooks`.

## Decisions

### 1. Headless never asks

No one is there to answer, so whatever would wait for a person is refused with
a reason, and the model continues. A question still gets the stop marker.

### 2. Three modes; presence decided separately

The mode says how much runs without approval. Whether a person is present
decides what happens to the rest.

| Mode | Runs without approval | Reviewer |
|---|---|---|
| `off` | only what needs no approval (inside the workspace, the scratch area, sandboxed shell) | none |
| `auto` | the above, plus what the reviewer approves outside it | decides outside-workspace and unsandboxed requests |
| `always` | everything except the floor | none |

| | Person present (TUI, ACP) | Nobody present (headless, or away) |
|---|---|---|
| leftover request | asked | refused, the model continues |

- `unattended` stays a mode (owner, 2026-11-22: "unattended mode: need
  permission → deny"). It is how a person chooses the nobody-present rules in
  the TUI and ACP: whatever needs permission is refused, with its refusal
  limits, workspace snapshot and escape refusal. No separate "away" switch.
  This replaced an earlier proposal to retire the mode.
- A bare `--auto-approve` raises `off` to `auto`. An explicit
  `--approval-mode` wins, and a saved `unattended` or `always` is kept.
  Headless with neither is `off`, so only what needs no approval runs, as the
  help text has always said.
- `auto` without a usable reviewer model is `off` at the edges: asked, or
  refused when nobody is present. That is the cost-free "workspace only" level.
- `NonInteractiveApprovalPolicy` no longer approves on its own: it keeps the
  allowlisted-MCP allowance and the check-in and `propose_goal` refusals, and
  refuses the rest. Its YELLOW → chore-tier fallback is replaced by the reviewer.

Why: users of a headless run expect it to finish, do the job, stay inside the
project and keep secrets. The safety level is theirs to choose; asking is not
available.

Not a change: inside the workspace nothing needs approval in any mode today.
File tools' `needsApproval` (for example in `src/tools/file/create-file.ts`)
already allows a physically contained workspace path, and a sandboxed shell
command needs none (`approvalFor` in `src/app/source-tools.ts`). The reviewer
in `auto` sees only outside, escape and unsandboxed requests.

### 3. The floor

Never automatic, in any mode including `always`: asked when a person is
present, refused otherwise. The existing hard gates (`ApprovalHardGate`) stay:

- questions, `propose_goal` and other `requiresExplicitUser` requests;
- run check-ins that grant budget or turns;
- Docker host control;
- denied credential reads.

Added:

- **Writes that change who checks the agent's work**, from file tools and from
  the sandboxed shell:
  - `.term2/hooks` (project and user) — hooks are trusted in-process code;
  - Term2's settings directory and the project's
    `.term2/sandbox-allow-paths.json` — they hold the approval mode, the
    sandbox switch and remembered read grants;
  - `.git/hooks` and `.git/config` — they run code on the user's next git
    command (`core.hooksPath`, `core.fsmonitor`).
- **Saved network grants** (`sandbox_network_access` that persists a
  destination). A one-time grant stays reviewer-decidable in `auto`.

Off the floor, by decision: sandbox escapes (a presence rule, above), MCP
tools (outside the wall: allowlisted ones run, the rest follow the mode), and
RED shell commands (the classifier is heuristic; a floor that depends on it is
unpredictable). `.github/workflows` was raised and not added.

Known current state: the sandbox runtime already denies shell writes to
`.git/hooks` when `.git` is a directory, but Term2 passes `allowGitConfig: true`
(`sandbox-policy.ts`), so `.git/config` is writable, and nothing in the sandbox
protects `.term2/`. `create_file` returns `needsApproval` false in `always`
before its hook-path check, so `always` writes hooks without asking.

Trade-off accepted: legitimate jobs on these paths ("switch my default model",
"fix my git hook", `git push -u`, which writes `.git/config`) need a person, and
fail headlessly.

### 4. Scratch area instead of `/tmp`

Models use `/tmp` for one-shot scratch files. Blocking it outright would cost
refusals, scratch files dropped in the repo, or turns ended by the refusal limit.

- The term2 temp directory (`SANDBOX_TEMP_DIR`, `/tmp/<user>/term2-nodejs` on
  Linux) is inside the wall in every mode, sandbox on or off, and `TMPDIR`
  points at it for shell commands either way.
- The shell tool description says to use `$TMPDIR` for scratch files.
- Writes to plain `/tmp` are outside the wall, as the sandbox already enforces:
  its writable paths do not include `/tmp`. With the sandbox off, the path
  classifier (`path-analysis.ts`) stops treating `/tmp` as safe; the refusal
  names `$TMPDIR`. With the sandbox on, the OS error (`Read-only file system`)
  for a `/tmp` path gets a one-line hint naming `$TMPDIR`; the hint adds text
  and never changes whether a command runs.
- Reads from `/tmp` are unaffected.

### 5. Credential locks

- **Term2's whole config directory** (`envPaths('term2').config`, or
  `TERM2_CONFIG_DIR`) joins the sandbox's denied reads. It holds
  `settings.json` (the only place API keys live since #342), `codex-auth.json`,
  `grok-auth.json` and MCP OAuth tokens. The whole directory, not listed files,
  so a file added there later is hidden by default: this gap opened when #342
  moved keys into `settings.json` and the list was not updated.
- **Other agents' credential files**, listed one by one: those Term2 reads as
  fallbacks (`~/.codex/auth.json`, `~/.chatgpt-local/auth.json`,
  `~/.grok/auth.json`) and other agents' token files once their exact names are
  confirmed. Their directories stay readable; they hold config and skills the
  agent legitimately reads.
- A `term2` started inside the sandbox finds no keys and fails with a clear
  message. Self-development points it at its own config with
  `TERM2_CONFIG_DIR`, as the test suites already do.
- Rejected for now: splitting keys out of `settings.json` (it reopens #342 and
  needs another settings migration for a rare case).
- Limit stated in user docs: these locks need the sandbox. With it off, a shell
  read is stopped only by the heuristic path classifier.

## Build list

Each item is a separate PR with its own evidence. Permission-boundary items
need an independent verifier (`verification` skill).

1. This plan.
2. Credential locks (decision 5).
3. The floor (decision 3).
4. Scratch area (decision 4).
5. Headless: leftover requests refused, `--auto-approve` = `auto`,
   `NonInteractiveApprovalPolicy` cut to refusals (decisions 1 and 2, headless side).
6. Dropped: `unattended` stays a mode (decision 2).

## Settled questions

- `unattended` stays a mode; no "away" switch (decision 2).
- `.git/config` stays writable from the sandbox, so standard git workflows
  (`git push -u`, `git switch -c x origin/main`) keep working (owner,
  2026-11-22). File tools still treat it as a floor path.
