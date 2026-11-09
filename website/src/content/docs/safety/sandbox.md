---
title: Shell Sandbox
description: Shell sandboxing policies, path protections, and network isolation.
---

The shell sandbox restricts which files a command can read or write and which network hosts it can reach. Commands that require the sandbox fail if its runtime is unavailable.

## Sandbox Policies (`sandbox.readPolicy`)

You can toggle the sandbox at any time with `/sandbox`, or configure policies via `/settings`:

### `standard` Policy (Default)
- **Filesystem Writes**: Strictly restricted to the workspace root directory and authorized temporary directories (`/tmp`, OS temp paths).
- **Sensitive Path Guard**: Blocks reading from sensitive credentials, secrets, and configuration directories:
  - `~/.ssh`
  - `~/.aws`
  - `~/.kube`
  - `~/.docker`
  - `~/.netrc`
  - Shell history files.

### `strict` Policy
- **Filesystem reads**: In addition to write restrictions, restricts read access exclusively to the active workspace directory and standard toolchain binaries.
- **Home & System Isolation**: Blocks general reads of the user's home directory and system root directories (`/etc`, `/var`, `/root`).

## Network Access (`sandbox.allowNetworking`)

By default, networking is denied (`deniedDomains: ['*']`) except for the built-in package-registry allowlist, which does not prompt. Approval prompts exist only when `sandbox.allowNetworking` is enabled:

- Toggle network permission via `/settings sandbox.allowNetworking true`.

## Custom Path Allowances (`sandbox.allowReadExtra`)

To allow the agent to read reference documentation or sibling libraries outside the project root without disabling the sandbox:

```json
{
  "sandbox": {
    "allowReadExtra": [
      "/usr/local/share/doc",
      "/opt/shared-libraries"
    ]
  }
}
```

## Read-only Gateway Sessions

A read-only grant blocks workspace writes even if the directory is writable. Workspace writes require both `term2 serve --allow-write` and a `read_write` grant.

Read-only gateway shell execution requires the filesystem sandbox with workspace writes disabled. If the sandbox is unavailable or disabled, an unsandboxed run is requested, or execution uses SSH rather than the local sandbox, the shell call is refused. Approval does not turn an unsandboxed general-purpose shell into a read-only one. This is a gateway-session policy, not a claim that every tool or remote service is covered by the shell sandbox.
