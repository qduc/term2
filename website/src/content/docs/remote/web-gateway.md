---
title: Web Gateway (term2 serve)
description: Running the private web gateway for companion web backends and ChatForge BFF.
---

`term2 serve` runs a private web gateway designed to connect web-based clients and companion application backends (such as the ChatForge BFF) directly to an authenticated term2 runtime.

## Command Syntax

```bash
term2 serve --local-owner <userId> [options]
```

The gateway runs in the foreground until interrupted (`SIGINT` / `SIGTERM`).

## Available Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--local-owner <userId>` | String | **Required.** The local user ID who owns the gateway instance and its workspaces. |
| `--state-dir <dir>` | String | Absolute path to gateway state directory. Defaults to `$XDG_STATE_HOME/term2-nodejs/gateway`. |
| `--socket <path>` | String | Path to Unix domain socket for IPC (default: `<state-dir>/gateway.sock`, mode `0660`). Mutually exclusive with `--listen`. |
| `--listen <host:port>` | String | TCP host and port for TLS network mode (e.g. `127.0.0.1:8443`). Mutually exclusive with `--socket`. Requires `--tls-cert` and `--tls-key`. |
| `--tls-cert <pem>` | String | Absolute path to TLS certificate PEM file (required when using `--listen`). |
| `--tls-key <pem>` | String | Absolute path to TLS private key PEM file (required when using `--listen`). |
| `--allow-remote` | Flag | Permit binding to non-loopback network interfaces. Without this flag, non-loopback listen hosts are refused. |
| `--pairing` | Flag | Enable interactive browser pairing mode for initial connection establishment. |
| `--bff-key <kid>=<pem>` | Repeatable | Register a paired BFF public key by key ID (`kid`) and certificate path. |
| `--workspace-root <dir>` | Repeatable | Add allowed workspace root directories. Defaults to the user's home directory. |
| `--issuer <iss>` | String | Expected JWT issuer claim (default: `chatforge-bff`). |
| `--audience <aud>` | String | Expected JWT audience claim (default: `term2-gateway`). |
| `--allow-write` | Flag | Admit `read_write` workspace grants. Without this flag, every workspace connection is strictly read-only. |

## Examples

### Local Unix Domain Socket (Default)

```bash
term2 serve --local-owner developer
```

Listens on the local Unix domain socket at `~/.local/state/term2-nodejs/gateway/gateway.sock` with read-only workspace access restricted to your home directory.

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
