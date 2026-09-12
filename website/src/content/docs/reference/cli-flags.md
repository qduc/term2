---
title: CLI Flags Reference
description: Complete reference of command-line flags for term2 and term2 serve.
---

## Interactive & Non-Interactive CLI (`term2`)

```
Usage:
  $ term2 [options] [prompt...]
  $ term2 [options] --resume [conversation-id|ls]
```

| Flag | Alias | Type | Default | Description |
| :--- | :---: | :--- | :--- | :--- |
| `--model <model>` | `-m` | String | Configured | Model pattern or ID. Supports `provider/id` and optional `:<thinking>` (e.g. `o3-mini:high`). Bare `-m`/`--model` opens the interactive picker in a TTY. |
| `--provider <provider>` | `-p` | String | `openai` | Override the configured provider (e.g. `openai`, `openrouter`, `grok`, `codex`). |
| `--reasoning <effort>` | `-r` | String | `default` | Set reasoning effort (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`). |
| `--lite` | `-l` | Boolean | `false` | Start in lite mode (minimal prompt, session-only context, no codebase indexing). |
| `--auto-approve` | — | Boolean | `false` | Allow tool execution without interactive prompts in non-interactive mode. |
| `--quiet` | `-q` | Boolean | `false` | Suppress non-error diagnostics on stderr in non-interactive mode. |
| `--show-reasoning` | — | Boolean | `false` | Stream reasoning/thinking deltas to stderr in non-interactive mode. |
| `--json` | — | Boolean | `false` | Emit newline-delimited JSON (NDJSON) events on stdout in non-interactive mode. |
| `--ssh <user@host>` | — | String | — | Enable SSH mode for a remote host. |
| `--remote-dir <path>` | — | String | — | Remote working directory (required for non-lite SSH sessions). |
| `--ssh-port <port>` | — | Number | `22` | SSH port. |
| `--grok-login` | — | Boolean | `false` | Log in to xAI Grok via browser PKCE OAuth and exit. |
| `--codex-login` | — | Boolean | `false` | Log in to OpenAI Codex/ChatGPT via browser PKCE OAuth and exit. |
| `--list-models [search]` | — | Boolean / String | `false` | Print available models grouped by provider, filtered by an optional search term. |
| `--refresh` | — | Boolean | `false` | With `--list-models`, bypass the model catalog cache and re-fetch from provider APIs. |
| `--resume [id\|ls]` | `-R` | Boolean / String | `false` | Resume the last conversation, a specific ID, or list recent conversations (`ls`). |
| `--fork` | — | Boolean | `false` | Fork the resumed conversation into a new session branch (requires `--resume`). |
| `--help` | `-h` | Boolean | `false` | Show help message and exit. |
| `--version` | `-v` | Boolean | `false` | Show version number and exit. |

---

## Web Gateway Launcher (`term2 serve`)

```
Usage:
  $ term2 serve --local-owner <userId> [options]
```

| Flag | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `--local-owner <userId>` | String | **Yes** | Local operator user ID owning the gateway and workspaces. |
| `--state-dir <dir>` | String | No | Gateway state directory. Defaults to `$XDG_STATE_HOME/term2-nodejs/gateway`. |
| `--socket <path>` | String | No | Unix domain socket path (default: `<state-dir>/gateway.sock`, mode 0660). Mutually exclusive with `--listen`. |
| `--listen <host:port>` | String | No | TCP host:port for TLS network mode. Mutually exclusive with `--socket`. Requires `--tls-cert` and `--tls-key`. |
| `--tls-cert <pem>` | String | Conditional | TLS certificate PEM path (required with `--listen`). |
| `--tls-key <pem>` | String | Conditional | TLS private key PEM path (required with `--listen`). |
| `--allow-remote` | Boolean | No | Allow binding non-loopback network interfaces with `--listen`. |
| `--pairing` | Boolean | No | Enable interactive client pairing mode for initial credential setup. |
| `--bff-key <kid>=<pem>` | String | No | Trusted client authentication public key(s) (repeatable). |
| `--workspace-root <dir>` | String | No | Allowed workspace root directories (repeatable). Defaults to user home directory. |
| `--issuer <iss>` | String | No | Expected token issuer claim for client authentication. |
| `--audience <aud>` | String | No | Expected token audience claim for client authentication. |
| `--allow-write` | Boolean | No | Admit `read_write` workspace grants. Without this flag, every root is strictly read-only. |
