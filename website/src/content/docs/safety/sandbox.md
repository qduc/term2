---
title: Shell Sandbox
description: Shell sandboxing policies, path protections, and network isolation.
---

term2 executes shell commands within an isolated sandbox environment designed to protect sensitive user data, system configuration files, and credentials from accidental modification or exposure.

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
  - Shell history and environment secret paths.

### `strict` Policy
- **Elevated Read Lockdown**: In addition to write restrictions, restricts read access exclusively to the active workspace directory and standard toolchain binaries.
- **Home & System Isolation**: Blocks general reads of the user's home directory and system root directories (`/etc`, `/var`, `/root`).

## Network Access (`sandbox.allowNetworking`)

By default, network calls from shell commands within the sandbox are monitored. Commands attempting outbound network connections require explicit user approval unless network access is configured in settings:

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
