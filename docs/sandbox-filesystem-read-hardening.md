# Sandbox Filesystem Read Hardening

Status: proposal (design doc, revised for compatibility-first rollout).

Follow-up to `docs/plans/sandboxing-proposal.md` (V1), which shipped network-denial, workspace write, env scrubbing, and a denylist of credential read paths. This doc proposes the next security tightening: **hardening home-resident reads and named system paths** (the runtime's read model is allow-by-default outside `denyOnly`, so we deny the home tree + a small system set and re-allow the workspace carve-out) and closing a **fail-open** gap, while keeping friction low for normal coding work.

Rollout principle: the fail-open fix is mandatory because it preserves the sandbox approval contract. The broader read policy should ship behind an explicit compatibility setting first, with a project-scoped approval escape hatch for legitimate development paths. Do not silently turn existing working projects into broken ones without an actionable path to remember narrowly scoped read allowances.

> **Scope caveat.** The runtime's read model is allow-by-default *everywhere not in `denyOnly`*. This proposal denies the home tree plus `/etc`, `/var`, `/root`, `/private/var` and re-allows the workspace + system binaries. It does **not** deny `/` — so `/srv`, `/mnt`, `/media`, `/opt/<app>/config`, application data dirs outside `$HOME`, and (on Linux) `/proc`, `/sys` remain readable. This removes the entire class of *home-resident* credential/source exfiltration and the named system recon paths; it is not a global read-bound. A deny-`/`-then-allow strategy is feasible (the runtime special-cases a deny of `/` to re-allow the root inode for traversal) but riskier for exec and is explicitly **out of scope** here. The acceptance criteria below reflect this narrower contract.

## Problem

V1's filesystem config is strong on writes/network but permissive on reads and silent when the sandbox cannot be honored:

```ts
filesystem: {
  denyRead: credentialFiles,   // ~10 credential paths only
  allowWrite: ['.', tmpDir],
  denyWrite: [],
}
```

Two concrete gaps surfaced in review (`source/utils/shell/sandbox/sandbox-policy.ts`):

1. **Reads are allow-by-default outside a short credential denylist.** A sandboxed command — driven by untrusted model output — can read sibling repos under `~/src`, `~/.kube/config`, `~/.npmrc`, `~/.config/gh/hosts.yml`, `~/.gnupg`, browser profiles, `/etc/passwd`, and anything else the credential list missed. The credential denylist is unbounded whack-a-mole: it cannot enumerate every future secret location, and it does nothing about non-credential exfiltration (source harvest, host recon).
2. **Fail-open on sandbox unavailability and wrap failure.** The approval gate (`shell.ts` `needsApproval`) returns `false` (auto-approved) when `sandbox === 'default'` *and* availability is `available`. When availability is `unavailable`, only commands classified as "mutating" require approval; non-mutating commands silently run **unsandboxed without approval**. Worse: if `needsApproval` returned `false` on the assumption the command would be sandboxed, and `shellSandboxRunner.wrap()` then throws inside `execute`, the command runs unsandboxed with only a `warn` log — the approval guarantee is bypassed entirely.

## Confirmed Runtime Facts

Verified against the published `@anthropic-ai/sandbox-runtime` README, `src/sandbox/sandbox-schemas.ts` (`FsReadRestrictionConfig`), `src/sandbox/sandbox-utils.ts` (`normalizePathForSandbox`, commit `7a725a31`), and `src/sandbox/sandbox-manager.ts` (`getCredentialRestrictions` → `unsetEnvVars`). The recommendation hinges on these:

- **`filesystem.allowRead` exists.** Reads use a **deny-then-allow** model: read is allowed everywhere by default; you deny broad regions and re-allow carved-out paths. `allowRead` **takes precedence over** `denyRead` (the opposite of writes, where `denyWrite` wins). Source: `sandbox-schemas.ts` — "`allowWithinDeny` takes precedence over `denyOnly` (most-specific rule wins)." README: "`allowRead` overrides `denyRead`… this is the opposite of write."
- **Reads are allow-by-default outside `denyOnly`.** `FsReadRestrictionConfig` comment: "`{denyOnly: [path]}` = deny reads from these paths, allow all others… maximally permissive by default — only explicitly denied paths are blocked." Denying `/Users` (or `/home`) + re-allowing `"."` is the README's documented workspace-only recipe and bounds **only the home tree**; the README states: "System paths (`/usr`, `/lib`, etc.) remain readable."
- **Auto-protected writes:** the runtime always blocks writes to `.bashrc`, `.bash_profile`, `.zshrc`, `.zprofile`, `.profile`, `.gitconfig`, `.gitmodules`, `.ripgreprc`, `.mcp.json`, and directories `.vscode/`, `.idea/`, `.claude/commands/`, `.claude/agents/`, `.git/hooks/`, `.git/config`, even inside `allowWrite`. We do not need to re-declare these.
- **`normalizePathForSandbox` already realpaths non-glob paths** (`sandbox-utils.ts` L252: `fs.realpathSync(normalizedPath)` with `isSymlinkOutsideBoundary` validation) and resolves relative paths (`"."`, `./…`, `../…`) against `process.cwd()` (L220-222). So V1's `allowWrite: ['.']` is already realpath-resolved by the runtime. `temp-dir.ts`'s explicit `realpathSync` is belt-and-suspenders that the runtime would do anyway; an explicit `workspaceRoot` pin is redundant for correctness and valuable only for **determinism/explicitness** (see §2).
- **macOS `/var` → `/private/var` is already canonicalized** by `normalizePathForSandbox` + `isSymlinkOutsideBoundary` (`sandbox-utils.ts` L101-129). Listing `/private/var` explicitly in `denyRead` is harmless belt-and-suspenders, not a gap correction.
- **`credentials.{files,envVars}` feed two mechanisms** (`sandbox-manager.ts` → `getCredentialRestrictions`): `credentials.files[mode=deny].path` is unioned into `denyOnly` (the read-deny set); `credentials.envVars[mode=deny].name` becomes `unsetEnvVars` passed to bwrap `--unsetenv` (Linux) / Seatbelt `-u` (macOS).
- **No `ExecutionContext` workspace-root concept exists.** `executionContext.getCwd()` returns `process.cwd()` (the launch directory, stable for the Node process — agent `cd` happens inside the sandboxed child, not the host). So the launch cwd is a natural, stable workspace root to pin against.

## Proposal

### 0. Roll out as policy levels, not a surprise default flip

Add a read-policy setting instead of replacing V1 behavior unconditionally:

```ts
sandbox: {
  enabled: true,
  readPolicy: 'standard' | 'strict',
  allowReadExtra: string[],
}
```

- `standard` preserves V1 read compatibility: only known credential paths are denied. This should remain the initial default while the stricter mode gets real usage.
- `strict` enables the hardening in §1: deny `$HOME` plus named system paths, then re-allow the workspace, temp dir, system tooling paths, and `sandbox.allowReadExtra`.
- `allowReadExtra` is project-scoped config, not a global relaxation. A path that is acceptable for one repository's package manager or build cache should not automatically become readable to every project.

Keep `sandbox.enabled=false` as the existing coarse escape, and keep `sandbox: "unsandboxed"` as the per-command approval-required escape. The new policy level is for users who want stronger reads without paying the full unsandboxed cost for normal tooling.

### 1. Harden home-resident reads and named system paths with deny-then-allow

When `sandbox.readPolicy === 'strict'`, replace the credential-only `denyRead` with a broad deny of the home tree and a small system set, then re-allow the workspace, temp, configured extra read paths, and a curated read-only tooling set. This is the runtime's documented workspace-only recipe extended with the system paths the README leaves open:

```ts
filesystem: {
  denyRead: [
    home,            // ~/.ssh, ~/.kube, ~/.npmrc, sibling repos, browser profiles — all denied
    '/etc',
    '/var',
    '/root',
    '/private/var',  // belt-and-suspenders; runtime already canonicalizes /var → /private/var
  ],
  allowRead: [
    workspaceRoot,   // explicit realpath of launch cwd (runtime would resolve "." too; pin for determinism)
    tmpDir,          // realpath (temp-dir.ts); redundant with runtime resolution, kept as local invariant
    ...allowReadExtraResolvedForProject,
    '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt',
    '/Library', '/System/Library',                // macOS system frameworks / man pages
    '/usr/local',                                   // Homebrew on Intel macOS
    '/opt/homebrew',                                // Homebrew on Apple Silicon
  ],
  allowWrite: [workspaceRoot, tmpDir],
  denyWrite: [],
  allowGitConfig: false,
},
```

Why this is the right tradeoff:

- **Workspace + system binaries + man pages cover ~all legitimate coding reads** (source, `node_modules` in the repo, toolchain, `man`, `pkg-config` lookups). Friction stays low.
- **The home subtree is denied except the workspace carve-out.** Because `allowRead` wins, `~/.ssh`, `~/.kube`, sibling repos under `~/src/otherrepo`, and `~/.config` caches are denied *even when the workspace itself lives under `~`* — the workspace `allowRead` entry is its realpath subpath, not all of `~`. This removes the entire class of "credential store I forgot to denylist."
- **Project-local `.env` is readable** (it is inside the workspace, and the agent legitimately operates on the project). This is in-scope for the agent and not an exfiltration target. Project secrets that must never be read by the agent belong outside the workspace, or behind the unsandboxed approval gate.
- **`allowRead` precedence caveat:** a credential path that falls *inside* an `allowRead` entry is readable. We keep the existing `credentials.files` deny list, but with the home `denyRead` in place the `credentials.files` entries are **fully redundant on the read side** — `getCredentialRestrictions` unions them into `denyOnly`, which already covers the home tree. Their remaining function is the `files` mode semantics (future `mask`); they earn their keep only if `allowRead` is ever re-broadened over `~`.
- **What stays readable (out of scope).** Because we do not deny `/`, paths outside the home tree and the named system set remain readable: `/srv`, `/mnt`, `/media`, `/opt/<app>/config`, application data dirs outside `$HOME`, and (on Linux) `/proc`, `/sys`. `/proc`/`/sys` are noted below as cheap-to-add. Network egress is already denied, so the leak surface is local-only reads — a narrower exposure than V1's blanket allow, but not a global read-bound.

Compatibility escape hatch: `sandbox.allowReadExtra: string[]` lets users with monorepo layouts or needed tool caches (for example pnpm stores, Cargo/Rustup installs, Maven caches, Python virtualenvs outside the repo, or `gh` config for `gh`-driven commands) extend `allowRead` without going fully unsandboxed. Going fully unsandboxed (`sandbox: "unsandboxed"`) remains the high-friction escape and still requires approval.

### 1a. Add "allow and remember this path for this project" to denied-read approval

Strict read mode needs an interactive compatibility path. When a sandboxed command fails because the runtime denied a read, surface an approval prompt that can persist the minimum useful path to this project's `sandbox.allowReadExtra`.

Prompt shape:

```text
Sandbox blocked read access:

  /home/user/.local/share/pnpm/store/v10/files/...

Options:
  Deny
  Allow once
  Allow and remember this path for this project
  Run command unsandboxed once
```

Decision rules:

- The prompt must show the resolved real path, because symlinked `node_modules` and language stores often hide the actual outside-workspace target.
- "Allow and remember" writes only to project-scoped settings, appending a normalized path to `sandbox.allowReadExtra` for the current workspace. It must not mutate global defaults.
- Suggest the smallest stable useful parent, not an arbitrary broad ancestor. For pnpm, prefer `~/.local/share/pnpm/store`; for Cargo, prefer `~/.cargo` and `~/.rustup`; for Maven, prefer `~/.m2/repository`. Do not auto-collapse to `~`, `~/.local`, or `~/.config`.
- Sensitive paths (`~/.ssh`, `~/.aws`, `~/.kube`, `~/.gnupg`, `~/.npmrc`, `~/.pypirc`, `~/.docker`, shell history, browser profiles, and broad config roots) should not offer "remember" by default. They may offer deny, allow once, or run unsandboxed once with explicit approval.
- The agent cannot add remembered read paths by calling a tool directly; persistence is a user approval decision.
- Log the path, project root, decision, and command correlation id through the existing logging/security path.

Implementation note: the runtime currently reports sandbox failures through stderr annotation, not as a structured denied-path event. The first implementation can parse only the runtime's known denial annotation format and fall back to the normal sandbox-blocked error when no path can be extracted. If the runtime later exposes structured denial metadata, switch to that instead of expanding ad hoc parsing.

### 2. Pin an explicit workspace root (determinism, not gap correction)

The runtime's `normalizePathForSandbox` already `realpathSync`s non-glob paths and resolves relative `"."` against `process.cwd()` (`sandbox-utils.ts` L220, L252). So V1's `allowWrite: ['.']` is already realpath-resolved; pinning an explicit `workspaceRoot` is **not correcting a missing realpath** — it is making the boundary **deterministic and explicit** in config so the rule is self-describing and survives any future change to the runtime's relative-path resolution base.

- Resolve `workspaceRoot = realpath(process.cwd())` once when the sandbox config is built. The runtime would resolve `"."` to the same value today; the explicit pin removes the reliance on `process.cwd()` being the resolution base at wrap time.
- Use `workspaceRoot` (absolute, resolved) for both `allowRead` and `allowWrite`, replacing the relative `'.'`. `temp-dir.ts`'s existing `realpathSync` of `tmpDir` is likewise redundant with the runtime's resolution but is kept as a local invariant.
- The boundary stays safe regardless: writes are allow-only and the only writable roots are `workspaceRoot` + `tmpDir`, so a sandboxed process cannot write through a symlink whose target resolves outside `allowWrite`.

The `cwd` passed to `executeShellCommandImpl` (where the child actually runs) can still follow the agent; only the *sandbox boundary* is pinned to the launch workspace root.

### 3. Close the fail-open gap

Two surgical changes in `source/tools/system/shell.ts`, routing into the existing approval path rather than inventing a new gate:

- **`needsApproval`:** when `sandbox === 'default'` and the sandbox is **not** `available` (unsupported platform, missing dependency, disabled by setting), return `true` — require approval — instead of falling through to `isMutatingCommand`. Rationale: the auto-approve-for-default-sandbox contract was granted *on the assumption of sandboxing*; if it can't be honored, the command is effectively unsandboxed and must go through the same approval the explicit escape uses. Non-mutating, non-networking commands are still low-risk, but "low-risk + silently unsandboxed" is the wrong default for a command stream that carries model output.
- **`execute` fail-closed on `wrap()` failure:** if `needsApproval` returned `false` on the sandbox assumption and `shellSandboxRunner.wrap()` then throws, **do not run unsandboxed.** Return an error directing the agent to retry with `sandbox: "unsandboxed"` (which re-enters approval). This restores the invariant that "approved as sandboxed" ⇒ "runs sandboxed or not at all." Acceptable friction: `wrap` failures are rare; when they occur, one unsandboxed retry with approval is the correct, auditable path — not a silent downgrade.

Keep the existing `warn` logs; they become useful telemetry rather than the sole mitigation.

**Overlap with env protection (§5):** the fail-open `wrap()` path is also an **env-leak** path. When `sandboxed` stays `false`, `execute` spawns with `env: undefined` (full `process.env`, secrets included), bypassing the Layer-1 allowlist from `createSandboxEnvironment()`. So §3 closes **both** the read-surface gap and the env-leak gap in one change; §5's Layer-1 guarantee *presupposes* §3 — without fail-closed, Layer 1 never applies when `wrap()` throws.

### 4. Extend the credential deny list (defense-in-depth)

Even with the home `denyRead`, extend `credentialFiles` for completeness and for the `credentials.files` mechanism (which also informs env handling). Add:

- `~/.npmrc`, `~/.pypirc`, `~/.kube`, `~/.gnupg`
- `~/.config/gh`, `~/.gem`, `~/.gemrc`
- `~/.config/hub`, `~/.docker/config.json`

This is secondary to #1; it matters mainly if a future config change re-broadens `allowRead` over `~`.

### 5. Env protection: make the allowlist authoritative, self-populate the deny list

The `credentialEnvVars` list looks short, but it is **not the protection layer**, so its length is a non-issue. Two layers exist, in this priority order:

**Layer 1 — the allowlist in `source/utils/shell/sandbox/sandbox-env.ts` (authoritative).** When sandboxed, `shell.ts` spawns the child with `env: createSandboxEnvironment()`, which keeps only `PATH, SHELL, TMPDIR, TEMP, TMP, TERM, HOME, LANG, LC_*` and drops **everything else**. Every allowlisted key holds a non-secret value (paths, locale tags, terminal type), so secrets never reach the child because they are not allowlisted — not because we named them. This is the correct, enumeration-free answer to "we can't list every secret": don't enumerate secrets, enumerate a tiny set of known-safe keys.

**Layer 2 — the runtime's `credentials.envVars` (defense-in-depth).** Verified in `sandbox-manager.js`: `getCredentialRestrictions()` turns `credentials.envVars` into `unsetEnvVars` flags (bwrap `--unsetenv` / Seatbelt equivalents) applied to the wrapped process. But the env bwrap sees is Layer 1's allowlist, so Layer 2 only unsets a subset of an already-clean env. It is redundant today; it earns its keep only if the allowlist ever regresses.

Three concrete actions:

1. **Document the layering.** Add a comment in `sandbox-policy.ts` stating that the authoritative env protection is the `sandbox-env.ts` allowlist, and that `credentials.envVars` is intentionally small defense-in-depth. This prevents a maintainer from "fixing" a perceived gap by editing the weaker list.

2. **Self-populate Layer 2 from the live env.** The runtime's `credentials.envVars` schema accepts only explicit `{name, mode}` entries (no regex), so a static list can't be exhaustive. Instead, at config build time, scan `process.env` for secret-shaped keys and add them all:

   ```ts
   const secretEnvVarNames = Object.keys(process.env).filter(isSecretKey);
   // credentials.envVars: secretEnvVarNames.map(name => ({ name, mode: 'deny' }))
   ```

   reusing the existing secret-shape matcher `isSecretKey` (currently a private function in `sandbox-env.ts`; it must be **exported** or extracted into a shared helper for reuse at config-build time). This makes Layer 2 automatically exhaustive for whatever is in the current env — no hardcoding — and turns Layer 2 into a real backstop the moment Layer 1 ever loosens. ~5 lines, enumeration-free.

3. **Document `isSecretKey()` as Layer-1a defense-in-depth, not a dead backstop.** Inside `createSandboxEnvironment`, `isSecretKey(key)` is **redundant today** because the allowlist is so small that every key it flags is already rejected by `!isAllowedKey(key)`. But it is **not dead** — it is the Layer-1 backstop against a future widening that admits a secret-shaped key (a plausible mistake, e.g. adding `AWS_*` to `ALLOWED_EXACT_KEYS`). Calling it "dead" invites exactly the weakening this doc worries about elsewhere. Frame the comment as: "Layer-1a backstop: redundant while the allowlist stays tiny; do not remove — it is the last line of defense inside Layer 1 if a secret-shaped key is ever allowlisted." The meaningful active secret-detection for Layer 2 lives in action #2.

**Related (non-secret) friction note:** the Layer 1 allowlist is security-sound but too narrow for toolchain env — it drops `NODE_OPTIONS`, `VIRTUAL_ENV`, `PYTHONPATH`, `JAVA_HOME`, `GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `PKG_CONFIG_PATH`, `CC`/`CXX`, `EDITOR`, etc. None are secrets, but losing them breaks sandboxed builds/tooling. This is a friction bug, not a security one; the fix is the same pattern (extend the allowlist with curated safe-by-value keys: paths and flags, never tokens). Tracked separately from the credential question.

## Threat-model notes

- **Symlinks (reads):** the *read* protection through a symlink is load-bearing on the deny set being complete. A process can `ln -s /etc/passwd ./link` (workspace write, allowed) then `cat ./link`; the read resolves to `/etc/passwd`, which is denied **only because `/etc` is in `denyRead`**. The same symlink into `/srv`, `/mnt`, or any path outside the deny set reads fine. So the symlink-read threat is fully contingent on §1's deny set; the fixture below should cover both the denied case (`~/.ssh`) and document the non-denied case (`/srv`) as known-open.
- **Symlinks (writes):** with the workspace root realpath-resolved and the only writable roots being workspace+temp, a sandboxed process cannot write a symlink that escapes `allowWrite` (writes are allow-only and the target resolves outside the allowed set). `normalizePathForSandbox` + `isSymlinkOutsideBoundary` already validate this.
- **Symlinked `node_modules` (friction):** the acceptance criterion "can read `node_modules` inside the workspace" holds only if `node_modules` physically resolves under the realpath workspace root. pnpm/monorepo layouts often symlink `node_modules` to a store outside the workspace (e.g. `~/.local/share/pnpm/store` or a sibling repo); `normalizePathForSandbox` realpaths it to that store, which is under the denied home root → unreadable and builds break. The `allowReadExtra` setting partly covers this; affected users would add the pnpm store path. Worth a explicit documentation note and a test fixture for the pnpm-style symlinked-`node_modules` case.
- **`/proc`, `/sys`:** on Linux these expose host info; consider adding to `denyRead`. Low priority — no network egress to leak through — but cheap. Also consider `/srv`, `/mnt`, `/media` for completeness, though these are less commonly host-recon targets.
- **macOS `/private/var` vs `/var`:** `normalizePathForSandbox` + `isSymlinkOutsideBoundary` already canonicalize `/var` → `/private/var` (`sandbox-utils.ts` L101-129), so a literal `/var` entry in `denyRead` resolves correctly. Listing `/private/var` explicitly is harmless belt-and-suspenders, not a gap correction.

## Files to change

- `source/services/settings/settings-schema.ts` and `source/services/settings/settings-sources.ts` — add `sandbox.readPolicy` and project-scoped `sandbox.allowReadExtra`; default `readPolicy` to `standard` for compatibility.
- `source/hooks/use-settings-value-completion.ts` — add completions for `sandbox.readPolicy` values.
- `source/utils/shell/sandbox/sandbox-policy.ts` — support both read policies; in `strict`, build deny-then-allow `filesystem` (home + named system paths); include project `allowReadExtra`; explicit `workspaceRoot` pin for determinism; extended `credentialFiles` (redundant on read side, kept for mode semantics); layering comment.
- `source/tools/system/shell.ts` — `needsApproval` requires approval when sandbox unavailable; `execute` fail-closed on `wrap()` failure; detect denied-read sandbox failures and raise an approval continuation that can allow once, remember for project, or rerun unsandboxed once.
- `source/components/prompt/ApprovalPrompt.tsx` — render denied-read approval options, including "Allow and remember this path for this project" only for non-sensitive suggested paths.
- `source/contracts/conversation.ts` / related approval contract types — add a typed approval payload for sandbox denied-read decisions and remembered-path metadata.
- `source/utils/shell/sandbox/sandbox-env.ts` — export `isSecretKey` (or extract to a shared helper) so it can be reused in §5 action 2; add the Layer-1a defense-in-depth comment (action 3).
- `source/utils/shell/sandbox/sandbox-policy.test.ts` — assertions for both read policies; in `strict`, assert the new `allowRead` set, home denial, workspace carve-out realpath, `allowReadExtra`, and that `allowRead` does not include the home root.
- `source/tools/system/shell.test.ts` and `source/components/prompt/ApprovalPrompt*.test.tsx` — denied-read prompt/decision coverage, sensitive-path suppression for remember, project-scoped persistence, and fail-closed wrap behavior.
- New runtime/integration-style test where practical: sandboxed `cat ~/.ssh/id_rsa` (and a symlink variant) is denied under `strict`; sandboxed `cat <workspace>/README.md` is allowed; a denied pnpm-store-style path can be remembered and then read on retry.

## Acceptance criteria

- With `sandbox.readPolicy=standard`, existing V1 read behavior is preserved except for the fail-closed sandbox fallback fix.
- With `sandbox.readPolicy=strict`, a sandboxed command cannot read `~/.ssh`, `~/.kube/config`, `~/.npmrc`, a sibling repo under `~/src`, or `/etc/passwd`.
- With `sandbox.readPolicy=strict`, a sandboxed command **can** read files in the workspace, `node_modules` that physically resolves under the realpath workspace root, `/usr/bin`, and man pages. (Caveat: pnpm/monorepo symlinked `node_modules` pointing outside the workspace is denied by default and requires an `allowReadExtra` entry — see threat-model notes.)
- When a legitimate outside-workspace read is denied, the user can approve once or approve-and-remember a non-sensitive suggested parent path for the current project; the next sandboxed retry includes that path in `allowRead`.
- Sensitive denied paths do not offer "allow and remember" by default.
- With `sandbox.readPolicy=strict`, a sandboxed command **can still** read `/srv`, `/mnt`, `/media`, `/proc`, `/sys` — these are out of scope (see §1 scope caveat). Document this as a known limitation, not a regression.
- `wrap()` failure on a default-sandbox command does not execute unsandboxed **and does not leak `process.env`** (the fail-open path currently spawns with `env: undefined`); the agent receives an error pointing to the unsandboxed escape.
- `sandbox: "unsandboxed"` continues to work as today (requires approval).
- Existing V1 tests still pass; the read surface change does not regress workspace-local shell work.

## Acceptance criteria (env)

- A secret present only in `process.env` (e.g. `NPM_TOKEN`) never reaches a sandboxed child, via the allowlist — independent of any `credentials.envVars` entry.
- Every present secret-shaped env var appears in the generated `credentials.envVars` deny list, so Layer 2 stays exhaustive without hardcoding.
- Adding a new allowlisted toolchain key (e.g. `JAVA_HOME`) does not permit any token-shaped value to leak.

## Open questions

- Exact project-settings write path for "allow and remember": use the existing settings source that represents the current project/workspace. If the settings system cannot currently distinguish project-local from global writes, add that boundary before enabling remembered paths.
- Should `sandbox.allowReadExtra` be a flat list or support workspace-relative globs? The runtime already does `~` expansion and resolves relative paths against `process.cwd()` in `normalizePathForSandbox`, so a flat absolute-path list matches runtime semantics cleanly. Globs work natively on macOS (regex-converted) and are expanded to concrete paths on Linux via `expandGlobPattern` (platform asymmetry worth documenting if globs are supported). Lean toward flat absolute paths + `~` expansion for manually configured paths; remembered paths should persist as normalized, non-glob absolute paths with `~` display compaction only in UI.
- Do we want a startup-time decision (refuse to run mutating/sandboxed commands at all on unsupported platforms) vs per-command approval? Current proposal is per-command approval via #3, which is lower friction and reuses the existing gate.
- For the toolchain-env friction note: do we curate a second safe-by-value allowlist, or allowlist a known prefix set (e.g. anything ending in `_HOME`, `*_PATH` minus `PATH`)? Prefix allowlisting risks widening the surface; curated list is safer but needs maintenance.
- After collecting enough denied-read data, should `strict` become the default? Default change should wait until common package-manager and language-cache paths have documented recipes and the remembered-path UX is proven.
