# Shell Sandboxing V1 Proposal

Status: draft.

## Goal

Reduce approval friction for normal local development commands by running shell commands inside a real OS sandbox by default.

V1 is intentionally shell-only. It does not redesign the direct file tools, add a general sandbox policy subsystem, or introduce a persistent full-access mode. The first version should make workspace-local shell work fast while preserving a clear approval escape hatch for commands that need network or host-level access.

## V1 Product Contract

Local shell commands run sandboxed by default and are auto-approved when the sandbox backend is available. The sandbox allows workspace read/write, denies network, withholds sensitive environment variables, and blocks arbitrary access to the user's home directory or system paths.

If the agent needs to run a command outside the sandbox, it must request an explicit one-shot escape with `sandbox: "unsandboxed"`. That request always requires human approval and is never eligible for LLM auto-approval.

Direct file tools keep their current workspace approval/path behavior. They are not part of the v1 sandbox guarantee.

## Reference Design

V1 should use [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) as the OS enforcement dependency rather than recreating platform-specific sandbox backends in Term2.

Term2 owns:

- shell tool API and user-facing behavior
- approval policy for unsandboxed escape
- sensitive environment scrubbing
- fallback behavior when sandboxing is unavailable
- command output and diagnostics

The sandbox runtime owns:

- macOS and Linux/WSL2 process confinement
- platform-specific filesystem and network enforcement
- process-tree enforcement for spawned subprocesses

Term2 should wrap the runtime behind a small internal adapter so its API does not leak into tool schemas, prompts, or user-facing docs.

## Current Repo Fit

The current seams that matter are:

- `source/tools/system/shell.ts` for the shell tool schema, approval decision, prompt-facing docs, and command formatting.
- `source/utils/shell/execute-shell.ts` for local spawned command execution.
- `source/services/settings/settings-schema.ts` for the single v1 setting.
- `source/services/execution-context.ts` for local vs SSH execution context.
- `source/services/subagents/tool-policy.ts` for subagent shell wrappers and restrictions.
- `source/services/conversation/conversation-result-builder.ts` and approval policy helpers for ensuring unsandboxed shell is never auto-approved.

V1 should not introduce a generic sandbox service used by every tool. The only v1 consumer is shell execution.

## Shell Tool API

Add an optional `sandbox` argument to the shell tool:

```ts
type ShellSandboxMode = 'default' | 'unsandboxed';

type ShellToolParams = {
  command: string;
  timeout_ms?: number;
  max_output_length?: number;
  sandbox?: ShellSandboxMode;
};
```

Behavior:

- `sandbox` defaults to `default`.
- `sandbox: "default"` runs local commands inside the sandbox when sandboxing is enabled and available.
- `sandbox: "unsandboxed"` always requires explicit human approval.
- Approval authorizes one execution of that exact tool call only.
- There is no persistent `danger-full-access` setting or mode.

If a sandboxed command is blocked at runtime, the shell output should tell the agent how to proceed:

```text
Error: Sandbox blocked network access. To proceed, call shell again with sandbox="unsandboxed"; user approval will be required.
```

The current approval architecture is based on `needsApproval` interruptions. V1 should use the explicit `sandbox: "unsandboxed"` argument to request approval, rather than adding a new mid-execution approval mechanism.

## Sandbox Policy

V1 policy is hard-coded except for `sandbox.enabled`.

Default sandbox behavior:

- workspace read/write is allowed
- network is denied
- sensitive environment variables are scrubbed
- arbitrary home directory and system path access is denied
- subprocesses inherit the same sandbox constraints

Sensitive environment variables should include known secret-bearing patterns such as `*_API_KEY`, `*_TOKEN`, `*_SECRET`, cloud credentials, SSH agent variables, and provider keys. Sandboxed commands should receive only the minimal developer environment needed to run local tools, such as `PATH`, locale variables, shell basics, and a sandbox/private `HOME` if supported by the runtime.

No v1 settings should be added for read-only mode, allowed domains, extra writable roots, network allowlists, or persistent full access.

## Settings

Add one setting:

```ts
sandbox: {
  enabled: boolean; // default true
}
```

Behavior:

- If `sandbox.enabled=true` and the backend is available, default local shell commands run sandboxed.
- If `sandbox.enabled=false`, shell falls back to the current approval-based behavior.
- If the backend is unavailable or cannot enforce the requested policy, shell falls back to the current approval-based behavior.
- The app should make fallback visible with a clear diagnostic such as: `Sandbox unavailable; using approval-based shell safety.`

Fallback must never silently auto-run unsandboxed commands that would previously have required approval.

## Approval Model

Sandboxing changes the approval philosophy:

- Workspace-local mutation is allowed without approval because the sandbox limits the blast radius.
- Approval is reserved for escaping the sandbox.
- Network access requires approval and runs as a one-shot unsandboxed command.
- Outside-workspace filesystem access requires approval and runs as a one-shot unsandboxed command.
- Sensitive environment access requires approval and runs as a one-shot unsandboxed command.

The existing shell command safety classifier should be kept, but its role changes when sandboxing is active. It should detect obvious sandbox escapes before execution, not block ordinary workspace-local mutation.

Examples:

- `pnpm test`, `rg`, `git status`, local builds: run sandboxed without approval.
- `rm -rf dist`, `git clean`, generated file cleanup inside the workspace: run sandboxed without approval.
- `pnpm install`, `curl`, `git fetch`, package downloads: require approval to run unsandboxed.
- `cat ~/.ssh/id_rsa`, writes to `/etc`, reads from arbitrary home paths: require approval to run unsandboxed.

Any `sandbox: "unsandboxed"` shell call must bypass LLM auto-approval. It requires explicit human approval even if the model or classifier considers the command safe.

## Platform Scope

V1 supports local shell sandboxing on macOS and Linux/WSL2 through the Anthropic sandbox runtime when its backend is available.

Native Windows is deferred. WSL2 is treated as Linux.

Remote SSH shell execution is excluded from v1 sandbox auto-allow. Remote commands keep the existing approval behavior because local sandboxing does not constrain the remote host.

## Subagents

All local shell execution paths should use sandboxed execution by default when the backend is available, including main agent, orchestrator, explorer, researcher, and worker shell paths.

Subagents must not be able to request unsandboxed shell execution directly. If a subagent discovers that work requires network or other unsandboxed access, it should report that need to the main agent. The main agent must perform the unsandboxed shell call itself with explicit user approval.

Main-agent prompt and tool guidance should state that unsandboxed work must not be delegated to subagents.

## Direct File Tools

V1 does not change these tools:

- `source/tools/file/read-file.ts`
- `source/tools/file/create-file.ts`
- `source/tools/file/apply-patch.ts`
- `source/tools/file/search-replace.ts`

They keep their current workspace approval/path behavior. Their checks are useful guardrails, but they should not be described as part of the v1 OS sandbox boundary.

Future hardening can revisit canonical path checks, symlink behavior, and a shared file-access policy, but that work is out of scope for v1.

## Implementation Plan

1. Add `sandbox.enabled` to `source/services/settings/settings-schema.ts`, defaulting to true.
2. Extend the shell tool schema in `source/tools/system/shell.ts` with `sandbox?: 'default' | 'unsandboxed'`.
3. Update shell `needsApproval` so `sandbox: 'unsandboxed'` always requires approval.
4. Update shell auto-approval policy so unsandboxed shell calls are never LLM-auto-approved.
5. Add a shell sandbox adapter around the Anthropic sandbox runtime. Keep the adapter narrow: command, cwd, timeout, max output, environment, and sandbox policy.
6. Route local `executeShellCommand()` calls through sandboxed execution by default when enabled and available.
7. Keep SSH execution on the existing unsandboxed remote path and existing approval behavior.
8. Scrub sensitive environment variables for sandboxed runs.
9. Update preflight classification so obvious network and outside-filesystem commands require `sandbox: 'unsandboxed'` approval instead of running sandboxed first.
10. Return clear sandbox-denial output that instructs the agent to retry with `sandbox: 'unsandboxed'` when appropriate.
11. Update subagent shell wrappers to reject or hide `sandbox: 'unsandboxed'` and ensure their local shell execution defaults to sandboxed execution.
12. Update main-agent prompt/tool docs to say unsandboxed work must be done directly by the main agent and must not be delegated.

## Tests

Add focused tests around shell behavior and approval policy:

- Shell schema accepts omitted `sandbox`, `sandbox: 'default'`, and `sandbox: 'unsandboxed'`.
- `sandbox: 'unsandboxed'` always returns `needsApproval=true`.
- Unsandboxed shell interruptions are not eligible for LLM auto-approval.
- Default local shell execution uses the sandbox runner when enabled and available.
- Sandbox unavailable falls back to current approval-based shell behavior.
- SSH execution does not use the local sandbox runner.
- Sensitive environment variables are omitted from sandboxed execution.
- Sandbox denial output tells the agent to retry with `sandbox: 'unsandboxed'`.
- Subagent shell wrappers reject or hide `sandbox: 'unsandboxed'`.
- Existing command-safety tests remain intact, but expectations should reflect the new role of the classifier under sandbox-enabled execution.

Do not add v1 tests for direct file-tool sandboxing, network allowlists, just-bash simulation, or generic file-access policy.

## Acceptance Criteria

The feature is ready when:

- With sandboxing enabled and backend available, ordinary local shell commands run without approval inside the sandbox.
- Sandboxed shell has workspace read/write, no network, scrubbed sensitive env, and no arbitrary home/system access.
- `sandbox: 'unsandboxed'` always requires explicit human approval and is never LLM-auto-approved.
- If the sandbox blocks a command, the shell output tells the agent to retry with `sandbox: 'unsandboxed'` if an escape is needed.
- If sandboxing is disabled or unavailable, shell behavior falls back to the current approval-based model.
- Remote SSH shell is excluded from sandbox auto-allow.
- Subagents run local shell sandboxed by default and cannot request unsandboxed execution directly.
- Existing file tools keep current behavior and are not part of the v1 sandbox guarantee.

## Out Of Scope For V1

- Native Windows support.
- Remote SSH sandboxing.
- Persistent full-access or `danger-full-access` mode.
- Network allowlists or domain-specific grants.
- Read-only sandbox mode.
- Extra writable roots or user-configurable filesystem policy.
- Direct file-tool redesign or shared file-access policy.
- just-bash test harness or offline simulator.
- New approval UI for mid-execution sandbox denial.

## Future Work

- Native Windows sandbox strategy.
- Remote sandboxing for SSH sessions.
- Optional network allowlists if one-shot unsandboxed approval proves too coarse.
- Shared file-access policy and stronger canonicalization for direct file tools.
- just-bash or another simulator for deterministic offline command tests.
- More granular sandbox escape modes, such as network-only, if user friction justifies the complexity.

The v1 design rule is simple: sandboxed shell is the default for local work, and unsandboxed shell is a one-shot human-approved escape hatch.

