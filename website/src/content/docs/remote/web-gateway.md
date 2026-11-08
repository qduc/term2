---
title: Web Gateway (term2 serve)
description: Running the private gateway for external clients and programmatic control.
---

`term2 serve` runs a private gateway service designed to connect external client applications, web interfaces, and local processes directly to an authenticated term2 agent runtime. **One of `--pairing` or `--bff-key` is required.**

## Separate Web Client

The repository's `web-client/` directory is a separate private Next.js application, not part of the `@qduc/term2` npm package or this documentation site. Updating the npm CLI updates the gateway backend; update and rebuild the web client separately for frontend changes such as Markdown/code rendering, grouped tool calls, and the refreshed composer/sidebar.

**Native browser v2 is enabled in matching source builds.** The root and web builds pin `@qduc/agent-wire` 0.2.3, including native background-task questions, tool tracking and activity observations. Use a server built from this revision with the separately built web client. Older gated builds return `503 agent_wire_v2_unavailable`; installing an older published CLI does not provide this support.

The browser hydrates one real accepted cut, then reconnects from its last fully applied accepted sequence. Accepted batches can have sparse sequences; live observations have no cursor. Reload never invents missing history or restarts a turn automatically. Tool effects are not undone by display replay.

See [shell sandbox restrictions](/term2/safety/sandbox/#read-only-gateway-sessions) for read-only workspace grants. A physically writable directory may be granted read-only access without granting runtime write permission.

## Command Syntax

```bash
term2 serve --local-owner <userId> --pairing [options]
```

The gateway runs in the foreground until interrupted (`SIGINT` / `SIGTERM`).

## Available Flags

| Flag | Type | Description |
| :--- | :--- | :--- |
| `--local-owner <userId>` | String | **Required.** The local user ID who owns the gateway instance and its workspaces. |
| `--state-dir <dir>` | String | Absolute path to native gateway state. The launcher substitutes the separate `gateway-next` directory for the old default `gateway` path; an explicit new directory avoids ambiguity. Old gateway data is never reused. |
| `--socket <path>` | String | Path to Unix domain socket for IPC (default: `<state-dir>/gateway.sock`, mode `0660`). Mutually exclusive with `--listen`. |
| `--listen <host:port>` | String | TCP host and port for TLS network mode (e.g. `127.0.0.1:8443`). Mutually exclusive with `--socket`. Requires `--tls-cert` and `--tls-key`. |
| `--tls-cert <pem>` | String | Absolute path to TLS certificate PEM file (required when using `--listen`). |
| `--tls-key <pem>` | String | Absolute path to TLS private key PEM file (required when using `--listen`). |
| `--allow-remote` | Flag | Permit binding to non-loopback network interfaces. Without this flag, non-loopback listen hosts are refused. |
| `--pairing` | Flag | Enable interactive client pairing mode for initial connection setup. One of `--pairing` or `--bff-key` is required; both may be set. `--allow-remote` is permitted by the parser, but do not combine it with pairing. |
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

Listens on the local Unix domain socket at `<effective-state-dir>/gateway.sock` (for example, `~/.local/state/term2-nodejs/gateway-next/gateway.sock` on Linux) with read-only workspace access restricted to your home directory. The one-time pairing code is printed to stderr and expires after five minutes; configure it in the BFF, never in the browser. In paired mode, the BFF may assert the `--local-owner` identity.

### Matching packed server and production BFF

Before v1.0 publication, use a local tarball and browser build from the same source revision. The current development manifest still says `0.40.0`; that version label alone does not identify the native candidate. Configure the CLI's provider/model first; provider credentials stay in the server process.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination /absolute/path/to/packages
npm install --prefix /absolute/path/to/server /absolute/path/to/packages/qduc-term2-0.40.0.tgz
/absolute/path/to/server/node_modules/.bin/term2 serve \
  --state-dir /absolute/path/to/new-native-state \
  --workspace-root /absolute/path/to/projects \
  --local-owner local-owner --pairing
```

Native dependencies must finish their installation scripts. If using pnpm for the packed installation, approve/build the same native dependencies allowed by the repository's `pnpm-workspace.yaml`; an installed package with ignored native builds is not a verified installation. On a network that requires `HTTPS_PROXY`, Node.js 24's fetch also requires the operator's `NODE_USE_ENV_PROXY=1`; setting proxy variables alone does not opt fetch into them.

In a separate terminal, configure and build the BFF from that same checkout:

```bash
export TERM2_GATEWAY_SOCKET_PATH=/absolute/path/to/new-native-state/gateway.sock
export TERM2_LOCAL_OWNER_USER_ID=local-owner
export TERM2_GATEWAY_PAIRING_ENABLED=true
export TERM2_GATEWAY_PAIRING_OTP='<current code from server stderr>'
NEXT_PUBLIC_TERM2_LOCAL_CONTROL_ENABLED=true pnpm --dir web-client build
pnpm --dir web-client start
```

Open `http://127.0.0.1:3000`. The BFF generates its private key once in `web-client/.data/gateway-client-key.pem` unless `TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH` names an existing private key. Preserve that file across restarts. Pairing mode signs using its public-key fingerprint; keep `TERM2_GATEWAY_PAIRING_ENABLED=true` for that identity and remove the OTP from the BFF environment after registration. Alternatively, use `--bff-key` plus the matching `TERM2_GATEWAY_KEY_ID` with pairing disabled.

Once activation is accepted, use Local owner controls to check/select an allowed root and create a session. The private session hydration route is **POST**, even though the browser calls a public GET through the BFF. Configuration changes retain their original request key and revision, including pending results; refreshing current configuration is a separate discovery request. An unavailable replay requires an explicit reload, not a downgrade.

Read-only grants remain read-only even when the filesystem is writable. `--allow-write` permits selecting `read_write`; it does not change an existing root's grant. Selecting a different access for the same root returns the named conflict and operator guidance. Conversation migration and in-place grant migration are not part of this setup.

Cost displays distinguish the known subtotal of supplied physical request receipts from native aggregate evidence. Missing prices/aggregate history are unavailable, not zero. Child receipt views refer to the same root charges and are never added twice.

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

For the complete client contract, see the [Web Gateway API Reference](/term2/reference/gateway-api/).

For editor integrations, term2 is also developing a separate
[Agent Client Protocol v2 adapter](/term2/reference/acp-v2/). It is not an
alternative transport for `term2 serve`; the Web Gateway remains the browser/BFF
integration surface.
