# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg?style=flat-square)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**term2 is an open-source AI assistant for coding and terminal work.**

Read a codebase, edit files, and run commands locally or over SSH. Choose your model, delegate work to subagents, and return to saved conversations.

![term2 tracing, fixing, and testing a real bug from its own history](docs/demo/demo.gif)

[Website & documentation](https://qduc.github.io/term2/) · [First run](https://qduc.github.io/term2/getting-started/first-run/) · [Changelog](CHANGELOG.md)

## What you can do

- **Work with a codebase.** Trace a failure, implement a feature, review a change, and run tests. Use `/plan` for read-only exploration.
- **Choose your models.** Connect a supported hosted provider or a local model endpoint. Switch models with `/model` and manage connections with `/providers`.
- **Delegate tasks.** Use [subagents](https://qduc.github.io/term2/modes/subagents/) for research, implementation, or review, including background work.
- **Keep working across sessions.** Resume a conversation after a break, fork it to try another approach, or work with a remote project over SSH.

## Get started

You need Node.js **20 or newer** (Node 24 recommended), an interactive terminal, and access to a model provider.

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

Ask it to explain the project, fix a bug, or implement a feature. Standard mode can apply valid local workspace edits without a prompt; shell commands require approval under the default interactive settings. Review the resulting diff before committing. Enter `/plan` for read-only exploration, then `/plan` again to return to Standard mode.

This README tracks `main`; npm releases may lag behind it. Check `term2 --version` and the [changelog](CHANGELOG.md) when following documentation for a newer feature.

## Useful commands

| To…                         | Use…                                                          |
| --------------------------- | ------------------------------------------------------------- |
| Switch models               | `/model` or `Ctrl+O`                                          |
| Manage provider connections | `/providers`                                                  |
| Resume a conversation       | `term2 --resume`; `term2 --resume ls` lists saved sessions    |
| Try another approach        | `term2 --resume <session-id> --fork`                          |
| Work over SSH               | `term2 --ssh user@host --remote-dir /path/to/project`         |
| Ask a one-off question      | `term2 "Explain the difference between a merge and a rebase"` |

A command-line prompt runs non-interactively, with tool execution disabled by default. `--auto-approve` enables tools without interactive confirmation; use it only when you intend unattended execution. See [scripting](https://qduc.github.io/term2/using-term2/non-interactive/) and [SSH setup](https://qduc.github.io/term2/remote/ssh/).

## Approvals and sandbox

Interactive sessions default to shell auto-approval `off` and an enabled shell sandbox. You can change these settings, so the active configuration matters. The sandbox constrains shell commands; it does not cover providers, external MCP servers, or every tool.

See [approvals](https://qduc.github.io/term2/safety/approvals/) and [sandbox boundaries](https://qduc.github.io/term2/safety/sandbox/) for the policies and their limits.

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

The separate [`web-client/`](web-client/) app connects to the private `term2 serve` gateway. See [gateway setup](https://qduc.github.io/term2/remote/web-gateway/).

## License

[MIT](LICENSE).
