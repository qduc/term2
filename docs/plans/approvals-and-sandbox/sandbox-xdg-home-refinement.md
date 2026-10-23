# Refined Plan: Sandbox XDG Redirection

## Context

Strict sandbox mode intentionally denies reads from most of the host home directory. That protects credentials and private source files, but it also causes friction for developer tools that assume they can read or write user config, cache, and data paths such as `~/.npmrc`, `~/.config`, `~/.cache`, or `~/.local/share`.

Redirecting XDG base directories into a sandbox-owned writable directory is a useful systemic mitigation. It changes the sandboxed process' definition of its config/cache/data locations instead of patching failures one command at a time.

This plan intentionally does not fake `HOME` in the first phase. Keeping `HOME` real preserves common host configuration discovery, such as Git identity, while XDG-aware tools get writable sandbox-local config, cache, data, and state directories.

This should be treated as a compatibility layer, not as a replacement for the strict read policy, denied-read approvals, or explicit unsandboxed escape path.

## Goals

- Reduce common strict-mode permission failures for tools that respect XDG base directories.
- Keep host credentials and private host config out of sandboxed child processes by default.
- Preserve the ability to approve legitimate host reads through the existing denied-read flow.
- Avoid replacing one security issue with shared, writable, predictable sandbox state.

## Non-Goals

- Do not guarantee that every permission-denied error disappears.
- Do not grant broad access to real host XDG directories.
- Do not silently run tools with host credentials or host auth state.
- Do not make sandboxed commands equivalent to normal host shell commands.

## Security Review

### Main Risk: Predictable Shared State

Do not use a fixed path such as `/tmp/sandbox_home`.

A fixed shared temp path can introduce several problems:

- Local disclosure if the directory is not private to the current user.
- Config poisoning if one command plants config consumed by a later command.
- Cross-project contamination if unrelated repositories reuse the same sandbox home.
- Sensitive data retention if tools write tokens, registry auth, package metadata, or downloaded artifacts into a long-lived temp location.

The sandbox home and XDG directories must be created under the app's existing sandbox temp root, with private permissions, and with enough scoping to avoid accidental reuse across unrelated contexts.

### Recommended Directory Model

Use a sandbox-owned directory below the existing `SANDBOX_TEMP_DIR` from `source/utils/shell/temp-dir.ts`.

Phase 1 layout:

```text
<SANDBOX_TEMP_DIR>/xdg/<workspace-hash>/
  config/
  cache/
  data/
  state/
```

Permissions:

- Create all directories with mode `0700`.
- Ensure the root is owned by the current user.
- Do not use world-writable paths directly as the sandbox XDG root.
- Prefer a stable per-workspace directory for cache reuse, but avoid sharing config/data across unrelated workspaces.

If stronger isolation is needed, split persistence by purpose:

- `XDG_CACHE_HOME`: stable per workspace, because cache reuse is useful and usually lower risk.
- `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME`: per session or resettable, because these can affect tool behavior and may contain sensitive state.

## What This Fixes

This approach should reduce failures from tools that try to read or write default user-scoped locations:

- npm, pnpm, yarn, Bun, and Deno cache/config discovery.
- Python and pip cache/config discovery.
- Tools that write under `$XDG_CACHE_HOME`, `$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`, or `$XDG_STATE_HOME`.

It is especially useful for commands that fail only because they want a writable cache or config directory and do not truly need host credentials.

## What This Does Not Fix

This will not cover every permission-denied case.

Expected remaining failures:

- Tools that ignore XDG and hardcode host paths.
- Tools invoked with explicit host config paths, such as `NPM_CONFIG_USERCONFIG`, `PIP_CONFIG_FILE`, `DOCKER_CONFIG`, `KUBECONFIG`, or similar variables/flags.
- Commands that legitimately need denied host credentials, such as SSH keys, Docker auth, GitHub CLI auth, Kubernetes config, cloud config, or private registry auth.
- Reads from sibling repositories or package stores outside the workspace that are denied by strict read policy.
- Writes outside the workspace or sandbox temp directory.
- Network-denied operations.
- Real filesystem ownership or mode errors inside the workspace.

Those cases should continue to use denied-read approval, project-scoped `sandbox.allowReadExtra`, or an explicitly approved `sandbox="unsandboxed"` retry.

## Host Config Compatibility Impact

Redirecting XDG directories can change workflows that depend on real host config under XDG paths. This is narrower than fake-home mode because `HOME` remains unchanged in phase 1.

Examples:

- Git should continue seeing `~/.gitconfig` when strict policy allows it, as it does today in this codebase. Git config under `~/.config/git` also remains available when allowed by the sandbox read policy.
- Package managers may stop seeing registry mirrors, corporate CA config, private registry auth, and user-level config.
- `gh`, Docker, Kubernetes, cloud CLIs, and SSH will lose host auth/config unless separately approved.
- Existing strict-policy allow-read entries for safe host paths may become irrelevant if tools no longer look at the real home.

This is desirable for credential isolation, but it is still a behavior change. Phase 1 deliberately avoids the larger compatibility break caused by fake `HOME`.

## Recommended Behavior

### Phase 1: XDG-Only Strict Mode

In strict mode, set sandbox-local XDG directories for sandboxed commands:

```bash
XDG_CONFIG_HOME=<sandbox-xdg-root>/config
XDG_CACHE_HOME=<sandbox-xdg-root>/cache
XDG_DATA_HOME=<sandbox-xdg-root>/data
XDG_STATE_HOME=<sandbox-xdg-root>/state
```

Also set tool-neutral temp variables consistently:

```bash
TMPDIR=<SANDBOX_TEMP_DIR>
TEMP=<SANDBOX_TEMP_DIR>
TMP=<SANDBOX_TEMP_DIR>
```

Keep `HOME` unchanged in phase 1.

Do not mount host config into the sandbox home and do not synthesize sanitized host config in this phase. Those mechanisms add policy complexity and are unnecessary until XDG-only behavior proves insufficient.

### Phase 2: Fake HOME Only If Needed

`HOME` redirection is more invasive than XDG redirection. Delay it until there is evidence of major remaining friction after phase 1.

If that evidence appears, add an explicit setting:

```text
sandbox.homeMode = "real" | "fake"
```

Suggested semantics:

- `real`: preserve current `HOME`; only filesystem policy blocks reads.
- `fake`: redirect XDG dirs and set `HOME` to a sandbox-owned home directory created for that later phase.

Rollout rule:

- Phase 1 default: `real`.
- Phase 2 default should remain `real` unless major strict-mode friction persists and fake `HOME` demonstrably fixes it.
- Even in phase 2, fake `HOME` should be opt-in first.

## Codebase Integration Points

Primary files:

- `source/utils/shell/sandbox/sandbox-env.ts`
- `source/utils/shell/sandbox/sandbox-env.test.ts`
- `source/utils/shell/temp-dir.ts`
- `source/utils/shell/sandbox/sandbox-policy.ts`
- `source/tools/system/shell.ts`

Implementation direction:

1. Add a helper that creates or resolves the sandbox XDG root directory below `SANDBOX_TEMP_DIR`.
2. Create `config`, `cache`, `data`, and `state` subdirectories with private permissions.
3. Extend `createSandboxEnvironment()` so it can receive sandbox runtime options, including cwd and read policy.
4. Keep the existing secret-stripping allowlist behavior. Adding XDG variables must not permit arbitrary host-provided `XDG_*` values through.
5. Populate XDG variables with sandbox-owned paths computed by the application, not copied from `process.env`.
6. Preserve the existing `HOME` behavior in phase 1.
7. Pass the same cwd/read-policy context from `source/tools/system/shell.ts` into `createSandboxEnvironment()` that is used to build the sandbox runtime config.

Important constraint:

The environment layer should synthesize trusted sandbox paths. It should not allow host `XDG_*` values just because their keys are allowlisted.

## Proposed Environment Contract

```ts
interface SandboxEnvironmentOptions {
  cwd: string;
  readPolicy: 'standard' | 'strict';
}
```

Expected behavior:

- Always strip secret-shaped variables.
- Preserve only the existing minimal safe env keys from the host.
- In strict mode, set XDG variables to app-created sandbox paths.
- Preserve the current safe `HOME` behavior in phase 1.
- Do not add fake `HOME` to this contract until phase 2 is explicitly approved.

## Tests

Add or update tests in `source/utils/shell/sandbox/sandbox-env.test.ts`:

- Keeps stripping secret-shaped variables even when XDG support is enabled.
- Does not pass through host-provided `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, or `XDG_STATE_HOME`.
- Synthesizes XDG paths under `SANDBOX_TEMP_DIR`.
- Creates sandbox XDG subdirectories with private permissions.
- Leaves `HOME` unchanged in phase 1.
- Produces stable per-workspace paths if that is the selected cache model.

Add shell-tool coverage if the integration is not obvious from unit tests:

- Strict sandboxed command receives sandbox-local XDG variables.
- Standard sandboxed command preserves current behavior unless configured otherwise.
- Unsandboxed commands do not receive the scrubbed sandbox environment.

## Acceptance Criteria

- Strict-mode sandboxed commands receive writable XDG directories inside the sandbox temp root.
- Host-provided `XDG_*` values are not copied into sandboxed child processes.
- Secret env vars remain stripped.
- The sandbox XDG root is private to the current user and not a fixed shared `/tmp/sandbox_home` path.
- `HOME` remains unchanged in phase 1.
- Legitimate host config access still goes through denied-read approval, remembered allow-read paths, or approved unsandboxed execution.
- Existing strict read protections for host credentials remain intact.

## Recommendation

Implement XDG redirection as a strict-mode compatibility feature and keep `HOME` real.

After shipping phase 1, measure which permission failures remain. Add fake `HOME` only as a later opt-in phase if major strict-mode friction still occurs and the remaining failures are clearly caused by legacy tools that ignore XDG. This preserves the security intent of strict mode while reducing the most common cache/config write failures without overcomplicating the first implementation.
