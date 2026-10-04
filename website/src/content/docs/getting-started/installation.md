---
title: Installation
description: Install term2 and check the prerequisites for your first session.
---

## Prerequisites

- **Node.js 20 or newer.** Node 24 is recommended and used by the documentation build.
- **pnpm 11 on your `PATH`.** The published 0.30.0 package invokes pnpm in its install hook, even when you install it with npm.
- **An interactive terminal** for model selection, chat, and approval prompts.
- **Provider access:** an API key, an eligible OAuth account, or a configured local model endpoint. Hosted provider billing and account limits apply.

## Install and verify

```bash
npm install --global pnpm@11
npm install --global @qduc/term2
term2 --version
term2 --help
```

You can also install with `pnpm add --global @qduc/term2` if your pnpm global bin directory is configured. If `term2` is not found, check that your package manager's global bin directory is on `PATH`.

As of October 3, 2026, npm's latest release is **0.30.0**. This website tracks `main`; see [what's new](/term2/getting-started/whats-new/) for unreleased changes.

## Shell sandbox prerequisites

The shell sandbox is enabled by default. term2 checks whether its runtime and dependencies are available and refuses sandboxed shell execution if they are missing.

- **Linux / WSL2:** install `bubblewrap` (`bwrap`), `socat`, and `ripgrep` (`rg`) using your OS package manager. The environment must permit the namespaces bubblewrap needs; restricted containers may not.
- **macOS:** the runtime uses the system's `sandbox-exec` facility.
- **Windows:** the sandbox runtime has platform-specific dependencies and setup. WSL2 provides the Linux path described above; WSL1 is not supported by the sandbox runtime. Native Windows prerequisites are described in the [sandbox runtime documentation](https://github.com/anthropic-experimental/sandbox-runtime).

See [sandbox boundaries](/term2/safety/sandbox/) for policy details.

## Other tools

- **git** for version control and worktree workflows.
- **fd** (`fd` or `fdfind`) for faster file discovery.
- **SSH access and credentials** for [remote sessions](/term2/remote/ssh/).

## Next step

[Connect a provider and try a first task →](/term2/getting-started/first-run/)
