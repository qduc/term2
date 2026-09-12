---
title: Web Gateway (term2 serve)
description: Running the private gateway for external clients and programmatic control.
---

`term2 serve` runs a private gateway service designed to connect external client applications, web interfaces, and local processes directly to an authenticated term2 agent runtime. **One of `--pairing` or `--bff-key` is required.**

## Command Syntax

```bash
term2 serve --local-owner <userId> --pairing [options]
```

The gateway runs in the foreground until interrupted (`SIGINT` / `SIGTERM`).

## Available Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--local-owner <userId>` | String | **Required.** The local user ID who owns the gateway instance and its workspaces. |
| `--state-dir <dir>` | String | Absolute path to gateway state directory. Defaults to the platform state directory (e.g. `$XDG_STATE_HOME/term2-nodejs/gateway` on Linux). |
| `--socket <path>` | String | Path to Unix domain socket for IPC (default: `<state-dir>/gateway.sock`, mode `0660`). Mutually exclusive with `--listen`. |
| `--listen <host:port>` | String | TCP host and port for TLS network mode (e.g. `127.0.0.1:8443`). Mutually exclusive with `--socket`. Requires `--tls-cert` and `--tls-key`. |
| `--tls-cert <pem>` | String | Absolute path to TLS certificate PEM file (required when using `--listen`). |
| `--tls-key <pem>` | String | Absolute path to TLS private key PEM file (required when using `--listen`). |
| `--allow-remote` | Flag | Permit binding to non-loopback network interfaces. Without this flag, non-loopback listen hosts are refused. |
| `--pairing` | Flag | Enable interactive client pairing mode for initial connection setup. Mutually exclusive with `--bff-key` and `--allow-remote`. |
| `--bff-key <kid>=<pem>` | Repeatable | Register a trusted client's public key by key ID (`kid`) and public-key PEM path for signed requests. |
| `--workspace-root <dir>` | Repeatable | Add allowed workspace root directories. Each path must be absolute. Defaults to the user's home directory. |
| `--issuer <iss>` | String | Expected token issuer value for client authentication. |
| `--audience <aud>` | String | Expected token audience value for client authentication. |
| `--allow-write` | Flag | Admit `read_write` workspace grants. Without this flag, every workspace connection is strictly read-only. Use only with an explicit `--workspace-root` narrower than `$HOME`. |

## Examples

### Local Unix Domain Socket (Default)

```bash
term2 serve --local-owner developer --pairing
```

Listens on the local Unix domain socket at `<state-dir>/gateway.sock` (for example, `~/.local/state/term2-nodejs/gateway/gateway.sock` on Linux) with read-only workspace access restricted to your home directory. The one-time pairing code is printed to stderr; enter it in the pairing client. In paired mode, the client may assert the `--local-owner` identity.

### Enabling Workspace Writes & Custom Roots

```bash
term2 serve \
  --local-owner developer \
  --bff-key web-ui=/absolute/path/to/web-ui-public-key.pem \
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
  --bff-key web-ui=/absolute/path/to/web-ui-public-key.pem \
  --workspace-root /home/developer/projects \
  --allow-write
```

With `--bff-key`, the browser must not pair and must not call the gateway directly: the backend-for-frontend (BFF) holds the key and makes gateway requests. BFF-key clients may assert `--local-owner`. Do not combine `--pairing` with `--allow-remote`.
