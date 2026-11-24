---
title: Web Interface and Gateway
description: Start the bundled local browser interface or run the private gateway separately.
---

## Start the browser interface

Install or update `@qduc/term2`, then run:

```bash
term2-web
```

Open `http://127.0.0.1:3000`. The command starts both the browser app and its private gateway; you don't need a checkout, a separate build, or a pairing code. Press `Ctrl+C` to stop both. If port 3000 is already taken, run `term2-web --port 3001` (or `PORT=3001 term2-web`).

On your first visit, follow the two-step checklist to **Connect** an AI provider (API key, OAuth sign-in, or preset/custom server) and **Browse** for a folder to work in, confirm access, and select **Start a new chat**. Use the left sidebar to switch folders, start multiple chats in the same folder, or return to an earlier chat.

The web app uses the same saved settings and provider credentials as the CLI. If you already set up a provider there, don't enter the key again. Start `term2-web` from the same shell environment if your CLI gets its credentials from environment variables. If a chat needs an API key that hasn't been configured, it will point you to **Settings**.

This is a single-user interface bound to loopback. You can pick a folder the user running Term2 can read and grant it read-and-write or read-only access. Approval mode controls which actions ask for approval. To allow only read-only grants, pass `--read-only`:

```bash
term2-web --read-only
```

Unlike `term2-web`, a separately run `term2 serve` gateway stays read-only unless you pass `--allow-write`.

In a writable session, a direct foreground shell call can request a one-time escape from the shell sandbox. The configured approval mode governs that request; an approved command can access files outside the selected folder. Read-only sessions cannot grant a shell escape.

Don't expose it through a proxy or port forward to other users. The signing key and Unix socket are temporary; gateway session state persists across launches.

## Run the gateway separately

For an external client, `term2 serve` starts just the private gateway. Use `--pairing` or `--bff-key`.

## Start a local gateway

For a local client, start a gateway with a one-time pairing code:

```bash
term2 serve --local-owner developer --pairing
```

The gateway stays in the foreground and prints the pairing code to stderr. Configure the code in the client backend, not in a browser; it expires after five minutes. Workspace access is read-only by default. To use the separate web client, follow the matching server and client setup below. Stop the gateway with `Ctrl+C`.

## Browser session behavior

The browser loads a session snapshot and reconnects from the last sequence it applied. Stored event sequences can have gaps. Live observations have no cursor. Reload restores recorded history without restarting the turn or undoing tool effects.

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

### Running the browser app separately from source

Use this setup only if you need to run the browser app separately, for example while developing `web-client/`. Build the gateway and browser app from the same source revision. Configure the CLI's provider/model first; provider credentials stay in the server process.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js serve \
  --state-dir /absolute/path/to/new-native-state \
  --workspace-root /absolute/path/to/projects \
  --local-owner local-owner --pairing
```

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

Read-only grants remain read-only even when the filesystem is writable. `--allow-write` permits selecting `read_write`; selecting a different access for an already saved folder returns the named conflict. To change a saved folder's access or remove it, open the folder picker and use the menu next to the folder under **Saved folders**. Changing access to read & write needs a server started with `--allow-write`. Either action restarts the folder's open chats. After an access change, existing chats keep working with the narrower of the access they started with and the folder's new access, so a chat never gains access; new chats get the folder's access. After removal, the folder's chats do not open again, even if you add the folder back. Conversation logs stay on disk; conversation migration is not part of this setup.

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

Editors can connect through [Agent Client Protocol](/term2/reference/acp-v2/).
