# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg?style=flat-square)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**term2 is an open-source AI assistant for coding and terminal work.**

Read a codebase, edit files, and run commands locally or over SSH. Choose your model, delegate work to subagents, and return to saved conversations.

![term2 tracing, fixing, and testing a real bug from its own history](docs/demo/demo.gif)

[Website & documentation](https://qduc.github.io/term2/) · [First run](https://qduc.github.io/term2/getting-started/first-run/) · [Changelog](CHANGELOG.md)

## What you can do

- **Work with a codebase.** Trace a failure, implement a feature, review a change, and run tests.
- **Choose your models.** Connect a supported hosted provider or a local model endpoint. Switch models with `/model` and manage connections with `/providers`.
- **Delegate tasks.** Use [subagents](https://qduc.github.io/term2/modes/subagents/) for research, implementation, or review, including background work.
- **Keep working across sessions.** Resume a conversation after a break, fork it to try another approach, or work with a remote project over SSH.

## Get started

You need Node.js **24 or newer**, an interactive terminal, and access to a model provider.

```bash
npm install --global @qduc/term2
term2 --version
```

On Linux, sandboxed shell commands also need `bubblewrap` (`bwrap`), `socat`, and `ripgrep` (`rg`). Install them with your OS package manager. Shell execution fails closed when the enabled sandbox is unavailable. See [installation](https://qduc.github.io/term2/getting-started/installation/) for platform details.

Choose one authentication path:

```bash
# ChatGPT / Codex: complete the browser login
term2 --codex-login

# Or OpenAI API: set your own API key in this shell
export OPENAI_API_KEY="your-api-key"
```

For other providers, follow [provider setup](https://qduc.github.io/term2/providers/). OpenRouter and Grok are built in; add direct Anthropic, Gemini, and local endpoints through `/providers`. An API key alone does not register a custom provider. Hosted providers receive the conversation context and tool results used for your request; their billing and account limits apply.

Open a project and select a model from the provider you authenticated:

```bash
cd /path/to/your/project
term2 --model
```

Ask it to explain the project, fix a bug, or implement a feature. term2 can apply valid local workspace edits without a prompt; shell commands require approval under the default interactive settings. Review the resulting diff before committing.

This README tracks `main`; npm releases may lag behind it. Check `term2 --version` and the [changelog](CHANGELOG.md) when following documentation for a newer feature.

## Useful commands

Type `/` to browse commands by section, or type a command name to narrow the list. In `/settings`, use Tab or the left and right arrows to browse sections, or type to search across all settings.

| To…                         | Use…                                                          |
| --------------------------- | ------------------------------------------------------------- |
| Switch models               | `/model` or `Ctrl+O`                                          |
| Restart the built CLI       | `/restart` (or `/restart stop` to stop background work)         |
| Manage provider connections | `/providers`                                                  |
| Resume a conversation       | `term2 --resume`; `term2 --resume ls` lists saved sessions    |
| Try another approach        | `term2 --resume <session-id> --fork`                          |
| Work over SSH               | `term2 --ssh user@host --remote-dir /path/to/project`         |
| Ask a one-off question      | `term2 "Explain the difference between a merge and a rebase"` |

Continue a saved session headlessly with `term2 --resume <session-id> "Follow-up prompt"` (or use `last` instead of an ID). Add `--fork` to keep the original session unchanged.

Every session uses the same default experience: a minimal prompt with subagent delegation. Choose models and reasoning effort with `/model` and `/effort`; there is no profile chooser. Legacy profile inputs and saved session metadata remain compatible; see [profile internals](docs/profiles/README.md).

A command-line prompt runs non-interactively and never asks: whatever would wait for a person is refused. In the default `off` mode, tool calls that need no approval can still run. `--auto-approve` selects `auto` unless an explicit or stronger saved mode takes precedence. If you relied on omitting the flag to disable tools in 1.x, see the [scripting migration guide](https://qduc.github.io/term2/using-term2/non-interactive/#upgrading-from-1x). See also [SSH setup](https://qduc.github.io/term2/remote/ssh/).

The optional [Discord bridge](docs/reference/discord-bridge.md#first-run-checklist)
attaches to existing opted-in terminal sessions. Start with `term2 discord --help`.
Replies require explicit `discord_send`; status, approvals and questions stay local.
Live mobile checks covered routing, explicit replies, local approval, pause/stop and
bridge restart. See the guide for tested scope and remaining limits.

`/restart` reloads the built CLI in place and resumes the conversation, recovering durably queued text (not unsaved editor drafts). It requires POSIX Node with `process.execve` support, a built `dist/cli.js` entry, and no Node flags, loaders, or `NODE_OPTIONS`. Live background work blocks restart unless you explicitly use `/restart stop`; active workspace leases reset to home scope. Finish foreground shell commands and pending input confirmations first. See [session restart](https://qduc.github.io/term2/using-term2/sessions/#restart-the-built-cli) for recovery limits.

## Approvals and sandbox

Interactive sessions default to shell auto-approval `off` and an enabled shell sandbox. You can change these settings, so the active configuration matters. The sandbox constrains shell commands; it does not cover providers, external MCP servers, or every tool.

The four approval modes are `off` (ask), `auto` (review, then ask if needed), `unattended` (review, then refuse if needed), and `always` (bypass eligible permission prompts without model review). Set them with `/auto-approve` or `--approval-mode`. Changing modes preserves `sandbox.enabled`. `shell.showReview` / `--show-review` separately controls assessments shown with human prompts; with `off`, it requests advice that cannot approve the action. Saved `advisory` settings migrate to `off` with review display enabled. In a non-interactive run, `--auto-approve` selects `auto`.

In `unattended`, repeated refusals end the run; questions can still ask, and sandbox escapes are refused unless `shell.unattendedEscapeReview` is enabled. `always` can grant eligible runtime network and supported foreground sandbox-escape requests with their one-time scoped grant; it keeps human-only decisions such as `propose_goal` and unsupported escape restrictions. The reviewer catches mistakes, but is not a security boundary. With the sandbox off or unavailable, or over SSH, it is the only layer between automatically reviewed shell commands and your machine. The approvals page lists unattended's limits.

Read-only gateway sessions require sandboxed shell execution: disabling the sandbox, requesting an unsandboxed command, or using an SSH execution context does not bypass the read-only restriction.

See [approvals](https://qduc.github.io/term2/safety/approvals/) and [sandbox boundaries](https://qduc.github.io/term2/safety/sandbox/) for the policies and their limits.

## Status

Supported:

- The interactive TUI and headless runs, including `--resume` and JSON output.
- The local web interface (`term2-web`) and private gateway (`term2 serve`). See [web setup](https://qduc.github.io/term2/remote/web-gateway/) for connection and access limits.
- The ACP subset described below: stable ACP v1 for editors such as JetBrains Air and Zed, and experimental ACP v2, an upstream draft verified only against the SDK 1.4.0 reference client.
- The Discord bridge for opted-in interactive sessions, subject to the tested scope and limits in its guide.

Experimental, and may change between releases: SSH remote projects and the standalone control socket (`term2 control`).

Point an ACP client at:

```sh
term2 acp --provider <provider> --model <exact-model-id>
```

The same command serves v1 and v2; the version comes from the client's
`initialize` request. Connect the client to stdin/stdout; diagnostics go to
stderr. ACP v2 requires the shell sandbox and sends approval-required tools to
the client. ACP v1 defaults to the same behavior, and its session-local approval
mode can switch to Assisted or turn the sandbox off. See the
[ACP reference](website/src/content/docs/reference/acp-v2.md) for session replay,
client versions and acceptance limits.


## Develop from source

Use Node 24 and pnpm 11:

```bash
git clone https://github.com/qduc/term2.git
cd term2
pnpm install --frozen-lockfile
pnpm build
pnpm start --help
```

Read [AGENTS.md](AGENTS.md) before changing code. Use focused tests for the affected area; integration and provider tests have separate commands in `package.json`.

The documentation site lives in [`website/`](website/):

```bash
pnpm --dir website install --frozen-lockfile
pnpm --dir website build
pnpm --dir website preview
```

Run `term2-web` after installing the npm package, then open `http://127.0.0.1:3000`. It starts the bundled web app and its private gateway together, without pairing. Press `Ctrl+C` to stop both. Access is local, and you can grant a folder read-and-write or read-only access when you pick it. Approval mode controls which actions ask for approval; an approved outside-sandbox command can access files outside that folder. Pass `--read-only` to allow only read-only grants. See [web setup](https://qduc.github.io/term2/remote/web-gateway/) for details.

## License

[MIT](LICENSE).
