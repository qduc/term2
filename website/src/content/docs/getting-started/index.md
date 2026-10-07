---
title: Overview
description: What to try with term2, how it works, and where to start.
---

term2 is an open-source AI assistant that works with files and tools in your terminal or over SSH. It helps you investigate a project, make a change, and check the result in the same conversation.

## Start with a concrete task

- **Explore a repo:** “Trace how a request reaches the database. Show me the relevant files.” Use read-only Plan mode before making changes.
- **Fix a small bug:** “Find the cause of this error, propose a fix, and run the focused test.” Review the diff and shell approval requests.
- **Investigate over SSH:** Connect to a remote working directory and ask the agent to inspect the service or project there.
- **Continue later:** Resume a saved conversation or fork it to explore another approach.

Follow [installation](/term2/getting-started/installation/), then the [first-run guide](/term2/getting-started/first-run/) for authentication, model selection, and a first read-only task.

## How a session works

Start term2 in the directory you want to work on. Select a model, describe the outcome you want, and inspect the work. Under default interactive settings, shell commands need approval and use a sandbox. Valid local workspace edits can apply without a prompt, so review the resulting diff. You can change those settings; check the active policy before unattended work.

Sessions are saved for [resumption and branching](/term2/using-term2/sessions/). Hosted models receive the context and tool results used for the request; a local terminal interface does not make hosted inference local. Provider billing and account limits apply.

## Choose your setup

OpenAI, ChatGPT/Codex, Grok, and OpenRouter are built in. Direct Anthropic, Gemini, and local endpoints are configured through `/providers`. See [provider setup](/term2/providers/) for the distinction between authentication and adding a provider.

When you need more than a single-agent session, explore [operating modes](/term2/modes/), [subagents](/term2/modes/subagents/), and [SSH](/term2/remote/ssh/). The private [`term2 serve` gateway](/term2/remote/web-gateway/) is an integration service used by external clients, including the separate `web-client/` app; this documentation site is built from `website/`.

## Project instructions and skills

term2 discovers `AGENTS.md` or `CLAUDE.md` in the project and parent directories. It also looks for skills in `.term2/skills`, `.agents/skills`, and `.claude/skills` in project and user scope. A skill is a directory containing a `SKILL.md` file.

## Release or main?

This site tracks `main`. Check `term2 --version` for your installation and `npm view @qduc/term2 version` for the latest published release. See [what's new](/term2/getting-started/whats-new/) before relying on newer features.
