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
| `--provider <provider>` | `-p` | String | Configured | Override the configured provider (e.g. `openai`, `openrouter`, `grok`, `codex`). |
| `--reasoning <effort>` | `-r` | String | Configured | Set reasoning effort (`default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`). |
| `--lite` | `-l` | Boolean | `false` | Start in lite mode (minimal prompt, session-only context, no codebase indexing). |
| `--auto-approve` | — | Boolean | `false` | Opt out of implicit Lite mode and enable tools in non-interactive mode. This uses GREEN/YELLOW heuristic policy, not `/auto-approve always`; RED shell commands remain refused. |
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
  $ term2 serve --local-owner <userId> --pairing [options]
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
| `--pairing` | Boolean | Conditional | Enable interactive client pairing mode for initial credential setup. |
| `--bff-key <kid>=<pem>` | String | Conditional | A trusted client's public key (by key ID and public-key PEM path) for signed requests (repeatable). |
| `--workspace-root <dir>` | String | No | Allowed absolute workspace root directories (repeatable). Defaults to user home directory. |
| `--issuer <iss>` | String | No | Expected token issuer value for client authentication. |
| `--audience <aud>` | String | No | Expected token audience value for client authentication. |
| `--allow-write` | Boolean | No | Admit `read_write` workspace grants. Use only with an explicit root narrower than `$HOME`; otherwise roots are strictly read-only. |

Gateway examples must include either `--pairing` or `--bff-key`. In BFF-only mode, the browser does not pair or call the gateway directly; the BFF holds the key. BFF-key clients may assert `--local-owner`.
