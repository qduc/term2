# SB-08 RTK shell-boundary owner-decision packet

Status: **owner decision pending.** This is an audit note and test packet, not a
Contract 05 record. The evidence below deliberately leaves **Contract 05
extension versus local RTK ownership unresolved**.

## Scope and boundary

`source/services/rtk-service.ts` has two distinct responsibilities:

- `ensureRtkInstalled` resolves a platform asset, downloads it, verifies its
  SHA-256 checksum, extracts it, and returns a cached executable path.
- `isRtkSupportedCommand` / `wrapWithRtk` parse the top-level shell AST and
  insert a quoted RTK executable prefix only at eligible command positions.

`createShellToolDefinition` is the public shell boundary. When RTK compression
is enabled, the command is local, and the RTK parser admits the command, the
shell asks the injected installer for a path and passes the resulting rewritten
text to its execution seam. SSH bypasses this path. A `null` installer result
falls back to the original command. An installer rejection propagates rather
than being converted into that fallback.

This packet changes only:

- `source/tools/system/shell.test.ts`
- this audit note

It changes no production source, Contract 05, tracker, configuration, fixture,
or contract record.

## Owner decision (intentionally unresolved)

The owner should choose after reviewing the shell-boundary characterization:

1. **Contract 05 extension.** Contract 05 owns command admission/execution
   safety, binary integrity, and truthful effect semantics. A later
   owner-approved change would add a focused RTK matrix row and update the
   Contract 05 owner record.
2. **Local service contract.** `rtk-service` owns a self-contained download and
   AST-transformation policy, while shell remains the only consumer. The local
   disposition retains a direct dependency arrow to the shell-security record.

Neither choice is selected here. The fact that RTK currently has one consumer
is not sufficient to resolve an external-effect/security ownership boundary.

## Post-approval shell characterization

The new shell tests inject `rtkInstaller`, `executeShellCommandImpl`, and the
SSH service through `ExecutionContext`. They do not use a network, an RTK
binary, or a real shell. Calls to `shell.execute` are treated as already past
the generic approval decision: the executor spy observes the command that the
shell would execute. They therefore do **not** prove that ordinary
`shell.execute` performed generic approval. The existing separate
`"shell needsApproval always prompts for unsandboxed execution"` test remains
the explicit approval characterization.

The executor-spy corpus uses independent literal expectations:

| Input | Expected command at the executor spy | Boundary fact |
| --- | --- | --- |
| `ls package.json` | `"/tmp/rtk/rtk" ls package.json` | eligible local command receives only the quoted prefix |
| `printf hello` | `printf hello` | wholly ineligible |
| `curl https://example.com` | `curl https://example.com` | wholly ineligible |
| `git log \| grep x` | `git log \| grep x` | explicitly characterized pipeline remains unchanged |
| `git status > out.txt` | `git status > out.txt` | explicitly characterized redirected command remains unchanged |
| `curl https://example.com && git log` | `curl https://example.com && "/tmp/rtk/rtk" git log` | mixed chain partially wraps the eligible sibling |

The last expected value is asserted literally in the test as:

```text
curl https://example.com && "/tmp/rtk/rtk" git log
```

The test also asserts that the installer is called exactly for the two
supported local corpus entries; it does not use a blanket string-removal
property. Existing `source/services/rtk-service.test.ts` remains parser-level
evidence for eligibility and wrapping. The new tests are the post-approval
integration evidence at the shell public boundary.

Additional boundary cases are covered with injected seams:

- an eligible local command plus an installer resolving `null` reaches the
  executor unchanged;
- an eligible SSH command reaches `ISSHService.executeCommand` unchanged and
  never invokes the RTK installer or local executor;
- an injected installer rejection is observable at `shell.execute` and the
  executor is not called.

## Evidence matrix

| Scenario | Expected result | Evidence |
| --- | --- | --- |
| Eligible local command, installer path | Only documented quoted RTK prefix insertion; original command text otherwise preserved | `shell.test.ts`, `shell execute characterizes the post-approval RTK command boundary` |
| Wholly ineligible local commands | Original text at executor | Same explicit corpus test |
| Mixed eligible/ineligible chain | Exact partial-wrap string, not a blanket pipeline/redirection claim | Same explicit corpus test |
| Installer resolves `null` | Original eligible command at executor | `shell execute leaves an eligible local command unchanged when RTK installation resolves null` |
| SSH | Original remote text; no local installer/executor | `shell execute bypasses RTK for SSH through the remote execution seam` |
| Installer rejects | Rejection propagates; no executor call | `shell execute propagates an injected RTK installer rejection` |
| Generic approval | Not claimed by this packet | Separate existing `needsApproval` test; direct execution is post-approval characterization |
| Parser-level policy | Existing allowlist, AST, pipeline, redirection, and checksum tests | `source/services/rtk-service.test.ts` |

## Characterized gaps (not defects classified here)

- `ensureRtkInstalled` returns an existing cached binary without re-verifying
  its checksum. This packet records the observation only; it does not prove a
  vulnerability or product defect and adds no red proof.
- Temporary archive/extraction names use `Date.now()`. This packet records the
  observation only; it does not prove a collision or product defect and adds
  no red proof.
- A current installer failure falls back to the unwrapped command when the
  installer itself returns `null`; the injected rejection case is intentionally
  distinct and proves propagation. No claim is made that all installation
  failures have one settlement policy.

## Verification

The required gates for this packet are:

```sh
NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb08-rtk-boundary test \
  source/services/rtk-service.test.ts \
  source/tools/system/shell.test.ts
pnpm --dir /home/qduc/term2/.worktrees/sb08-rtk-boundary exec prettier --check \
  source/tools/system/shell.test.ts \
  docs/plans/service-boundary-contract-completion-sb08-rtk.md
git -C /home/qduc/term2/.worktrees/sb08-rtk-boundary diff --check
pnpm --dir /home/qduc/term2/.worktrees/sb08-rtk-boundary typecheck
```

Verification run in the dedicated worktree:

- Focused gate: **2 files / 126 tests passed** (`rtk-service.test.ts` and
  `shell.test.ts`).
- Prettier check: **passed**.
- `git diff --check`: **passed**.
- Typecheck: **passed**.
- Full suite: **483 files passed, 1 skipped, 1 failed; 6,240 tests passed,
  2 skipped, 1 failed**. The sole failure is the pre-existing settings-schema
  baseline: `maxModelRequestDurationMs` expected `0`, received `300000`.

All non-Git commands were run through the dedicated worktree with an explicit
`pnpm --dir /home/qduc/term2/.worktrees/sb08-rtk-boundary` prefix. Provider
black-box testing is not required: this packet changes neither provider,
bridge, run-loop, registry, non-interactive production behavior, nor
production source. If RTK is later placed in Contract 05, the Contract 05
focused suite becomes required at that separately authorized contract-update
stage.
