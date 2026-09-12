---
title: Web Gateway (term2 serve)
description: Running the private gateway for external clients and programmatic control.
---

`term2 serve` runs a private gateway service designed to connect external client applications, web interfaces, and local processes directly to an authenticated term2 agent runtime.

## Command Syntax

```bash
term2 serve --local-owner <userId> [options]
```

The gateway runs in the foreground until interrupted (`SIGINT` / `SIGTERM`).

## Available Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--local-owner <userId>` | String | **Required.** The local user ID who owns the gateway instance and its workspaces. |
| `--state-dir <dir>` | String | Absolute path to gateway state directory. Defaults to `<state-dir>` (e.g. `$XDG_STATE_HOME/term2-nodejs/gateway` on Linux). |
| `--socket <path>` | String | Path to Unix domain socket for IPC (default: `<state-dir>/gateway.sock`, mode `0660`). Mutually exclusive with `--listen`. |
| `--listen <host:port>` | String | TCP host and port for TLS network mode (e.g. `127.0.0.1:8443`). Mutually exclusive with `--socket`. Requires `--tls-cert` and `--tls-key`. |
| `--tls-cert <pem>` | String | Absolute path to TLS certificate PEM file (required when using `--listen`). |
| `--tls-key <pem>` | String | Absolute path to TLS private key PEM file (required when using `--listen`). |
| `--allow-remote` | Flag | Permit binding to non-loopback network interfaces. Without this flag, non-loopback listen hosts are refused. |
| `--pairing` | Flag | Enable interactive client pairing mode for initial connection setup. |
| `--bff-key <kid>=<pem>` | Repeatable | Register a trusted client's public key by key ID (`kid`) and public-key PEM path for signed requests. |
| `--workspace-root <dir>` | Repeatable | Add allowed workspace root directories. Defaults to the user's home directory. |
| `--issuer <iss>` | String | Expected token issuer value for client authentication. |
| `--audience <aud>` | String | Expected token audience value for client authentication. |
| `--allow-write` | Flag | Admit `read_write` workspace grants. Without this flag, every workspace connection is strictly read-only. |

## Examples

### Local Unix Domain Socket (Default)

```bash
term2 serve --local-owner developer
```

Listens on the local Unix domain socket at `<state-dir>/gateway.sock` (for example, `~/.local/state/term2-nodejs/gateway/gateway.sock` on Linux) with read-only workspace access restricted to your home directory.

### Enabling Workspace Writes & Custom Roots

```bash
term2 serve \
  --local-owner developer \
  --workspace-root /home/developer/projects \
  --allow-write
```

### TLS Network Mode

```bash
term2 serve \
  --local-owner developer \
  --listen 127.0.0.1:8443 \
  --tls-cert /path/to/server.crt \
  --tls-key /path/to/server.key \
  --allow-write
```
