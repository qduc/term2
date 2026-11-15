# Shell sandbox for development

Term2 runs shell commands inside the sandbox by default. Commands can edit the
checkout, use a temporary directory, and reuse a project dependency cache.
Term2 supplies XDG cache paths and cache locations for tools such as npm and
pip that use different defaults. Other tools can point their caches at
`$XDG_CACHE_HOME` or a directory in the checkout. Credentials inherited from the host process
are filtered and common credential files remain protected.

## Network approval

The first foreground connection to a destination through the sandbox proxy
asks for a host and port. **Allow once** applies to the current command.
**Always allow host for this project** also covers later sessions and sibling
registered Git worktrees. Approval covers all URLs and repositories on the specified host and port. Use a separate credential with the scope your task needs
when a service requires authentication. Git over SSH also uses the approval
proxy. Use a task-specific identity and pinned host key that the sandbox can
read. The host's SSH agent and default private keys stay protected. To add SSH
identity or host-key options for a command, append them to the sandbox-provided
`GIT_SSH_COMMAND` so Git retains the proxy settings.

For automation, an operator can provision or revoke endpoints from a regular
host terminal in the project directory.

```sh
term2 sandbox-network allow git.example.com 443
term2 sandbox-network allow registry.example.com 443
term2 sandbox-network revoke git.example.com 443
```

Term2 stores decisions in its user-level state. Headless and background runs can
reuse approvals but require a previously approved destination. Tools need to
honor the sandbox's HTTP or SOCKS proxy to use this approval path.
`sandbox.allowNetworking=false` disables outbound network access.

## Local listeners

On macOS, an operator can enable listeners for one project, including sibling Git
worktrees, from a regular host terminal.

```sh
term2 sandbox-network listen allow
term2 sandbox-network listen revoke
```

Bind a dev server to `127.0.0.1` or `::1` for local access. This permission
allows direct loopback connections and wildcard binds, which may expose
services on the local network. While a background sandboxed command is running,
use a host browser or terminal to reach its listener. The
Linux backend uses a separate network namespace for each sandboxed command.

## Git worktrees

The sandbox recognizes a linked checkout by validating the Git pointers on
both sides of the link. That adds access to its registered metadata and
selected shared Git paths while leaving hooks, shared configuration, and other
worktrees' files outside the grant. On macOS, the grant also includes the files
used for packed refs and shallow history, including temporary lock files.
