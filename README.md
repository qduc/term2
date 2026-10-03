# term2

[![npm version](https://img.shields.io/npm/v/@qduc/term2.svg?style=flat-square)](https://www.npmjs.com/package/@qduc/term2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)

**An AI assistant that works in your terminal, with your files and tools.**

Explaining a codebase to a chat window, copying commands back and forth, and rebuilding context after a break all get in the way of the work. term2 can read a project, edit files, and run commands in a local or SSH workspace. You can inspect the proposed work, choose your model provider, and resume a saved conversation.

Use it to:

- **Find your way through a repo.** Ask where a behavior lives, trace a failure, or review a change in read-only Plan mode.
- **Make and check a small change.** Have the agent edit the relevant files and run a focused check. Review the diff and approve shell commands under the default interactive settings.
- **Work on a remote machine.** Use the same conversation workflow over SSH without manually relaying each command and result.

[Website & documentation](https://qduc.github.io/term2/) · [First run](https://qduc.github.io/term2/getting-started/first-run/) · [Changelog](CHANGELOG.md)

## Try it

You need Node.js **20 or newer** (Node 24 recommended), an interactive terminal, and credentials for a model provider. Provider usage is billed or limited by that provider; term2 is MIT licensed.

The published **0.30.0** package's install hook invokes **pnpm**, so pnpm 11 must be on your `PATH` even when installing with npm:

```bash
npm install --global pnpm@11
npm install --global @qduc/term2
term2 --version
```

For sandboxed shell commands on Linux, install `bubblewrap` (`bwrap`), `socat`, and `ripgrep` (`rg`) with your OS package manager. Shell execution fails closed if its sandbox dependencies are unavailable. See [installation](https://qduc.github.io/term2/getting-started/installation/) for platform details.

Choose one authentication path:

```bash
# ChatGPT / Codex: complete the browser login
term2 --codex-login

# Or OpenAI API: set your own API key in this shell
export OPENAI_API_KEY="your-api-key"
```

Open a project and select a model from the provider you authenticated:

```bash
cd /path/to/your/project
term2 --model
```

In the chat, enter `/plan`, then try:

> Explain how this project starts. Point me to the entry points and the command for running its tests.

Plan mode blocks workspace mutations. When you're ready to change something, enter `/plan` again to return to Standard mode and ask for a small edit and a focused check. Valid local workspace edits can apply without a prompt; review the resulting diff and any approval requests before committing.

If you use another provider, follow [provider setup](https://qduc.github.io/term2/providers/). OpenRouter and Grok are built in; direct Anthropic, Gemini, and local endpoints are added through `/providers`. An API key alone does not register a custom provider.

## Keep the workflow in one place

| When you need to… | Use… |
| --- | --- |
| Pick a different model | `/model` or `Ctrl+O`; `/providers` manages connections and accounts |
| Return after a break | `term2 --resume`; `term2 --resume ls` lists saved sessions |
| Explore another approach | `term2 --resume <session-id> --fork` creates a separate conversation |
| Inspect a remote project | `term2 --ssh user@host --remote-dir /path/to/project` |
| Ask a one-off question | `term2 "Explain the difference between a merge and a rebase"` |

A command-line prompt runs non-interactively, with tool execution disabled by default. `--auto-approve` enables tools without interactive confirmation; use it only when you intend unattended execution. See [scripting](https://qduc.github.io/term2/using-term2/non-interactive/) and [SSH setup](https://qduc.github.io/term2/remote/ssh/).

## Controls and limits

Interactive sessions default to shell auto-approval `off` and an enabled shell sandbox. You can change approval policy and sandbox settings, so the active configuration matters. The sandbox constrains shell commands; it is not a blanket guarantee over providers, external MCP servers, or every tool. Hosted providers receive the conversation context and tool results used for your request.

Longer tasks can use subagents, background work, session goals, and context compaction. These are optional tools to configure as your workflow grows. Start with [modes](https://qduc.github.io/term2/modes/), [approvals](https://qduc.github.io/term2/safety/approvals/), and [sandbox boundaries](https://qduc.github.io/term2/safety/sandbox/).

## Releases and integrations

As of October 3, 2026, npm's latest release is **0.30.0**, published September 29. `main` includes later changes, including terminal themes/skins and web client fixes; installing from npm does not include those changes yet. Check [what's new](https://qduc.github.io/term2/getting-started/whats-new/) and `term2 --version` when following documentation for newer features.

The product website lives in [`website/`](website/) and publishes to [GitHub Pages](https://qduc.github.io/term2/). The separate [`web-client/`](web-client/) application connects to the private `term2 serve` gateway; it is not the documentation site. See [gateway setup](https://qduc.github.io/term2/remote/web-gateway/) for integration requirements.

## Develop from source

Use Node 24 and pnpm 11:

```bash
git clone https://github.com/qduc/term2.git
cd term2
pnpm install --frozen-lockfile
pnpm build
pnpm start --help
```

For the documentation site:

```bash
pnpm --dir website install --frozen-lockfile
pnpm --dir website build
pnpm --dir website preview
```

Read [AGENTS.md](AGENTS.md) before changing code. Use focused tests for the affected area; integration and provider tests have separate commands in `package.json`.

## License

[MIT](LICENSE).
