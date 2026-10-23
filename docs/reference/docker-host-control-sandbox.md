# Docker Host Control in the Shell Sandbox

Docker Desktop's macOS socket is `~/.docker/run/docker.sock`. The whole `~/.docker` tree remains in the sandbox credential deny list because it can contain Docker configuration and registry credentials.

Term2 recognizes a Docker invocation from the command itself (`requestsDockerHostControl` in `source/utils/shell/sandbox/docker-host-control.ts`) rather than from a tool parameter the model has to remember to set. Detection scans command position through quoting, so `docker`, `(docker ps || true) && …`, `sudo docker …`, `DOCKER_BUILDKIT=1 docker build .`, and `docker-compose up` all require approval, while `cat Dockerfile` and `git commit -m "fix(docker): …"` do not. Docker reached indirectly — from a script, `make` target, or package command — is out of reach of any command-string check. Those are caught after the fact instead: when a sandboxed run fails with a blocked daemon connection, `classifySandboxFailure` returns `docker_blocked`, the command is recorded as denied, and the agent is told to retry it. The retry requires approval and, once granted, runs with host control. The record is dropped as soon as the user decides, so a refusal lets the command run sandboxed again rather than stalling on approval. Only Docker is covered: other container CLIs such as `podman` have their own sockets and remain blocked.

A daemon failure during a run that already held host control is not attributed to the sandbox — that is Docker's own error (for example, Docker Desktop not running) and is reported unchanged.

When a user explicitly approves a Docker command, Term2 adds two narrow exceptions for that command only:

- the exact Unix socket is added to the sandbox runtime's `allowUnixSockets` list;
- the exact socket pathname is added to `filesystem.allowRead`.

The sandbox runtime gives an exact `allowRead` path precedence over `denyRead`. This permits the approved daemon connection while keeping `~/.docker/config.json`, sibling files, and the rest of `~/.docker` denied. Docker uses a fresh private `DOCKER_CONFIG` directory, so host Docker credentials are not passed to the command.

One-shot and session approvals belong to a conversation session identity. A generic approval (`y`) is rejected for Docker host control; the dedicated Docker approval options issue the required grant. Persistent project grants are listed in `/settings` under **Safety** as `sandbox.dockerHostControlProjects`; remove a project path there to revoke it.

## Tests

The regular test suite includes a sandbox-runtime test using a temporary Unix socket and credential file. It proves that a socket below a credential-denied `.docker` directory fails without the explicit socket exception, succeeds with it, and still cannot read the sibling `config.json`. It does not require Docker Desktop or a live daemon.

An opt-in macOS Docker Desktop check is available for maintainers:

```bash
pnpm test:docker-host-control-integration
```

It is skipped with the reason shown in the test name unless all prerequisites are present: macOS, Docker CLI, Docker Desktop's per-user socket, a running Docker daemon, and the sandbox runtime. The daemon probe and the exercised command are both the non-mutating `docker version`. When enabled, the harness verifies it is rejected before a grant, then succeeds after an explicit one-shot grant, in both a bare and a subshell-wrapped form. A second case runs Docker through `sh -c`, where the command string hides it, and verifies the blocked run turns into an approvable retry. It does not create, change, or remove containers, images, or volumes.
