---
title: Overview
description: How term2 sessions use tools, project instructions, and skills.
---

term2 reads files, edits code, and runs commands in a local or SSH workspace.
Follow [installation](/term2/getting-started/installation/) and the
[first-run guide](/term2/getting-started/first-run/) to connect a provider and
send your first prompt.

## How a session works

Start term2 in the directory you want to work on. Select a model and describe
the task. By default, interactive shell commands require approval and run in a
sandbox. Edits within the local workspace can apply without a prompt. Review the
diff before committing changes.

Use [`term2 --resume`](/term2/using-term2/sessions/) to reopen a saved
conversation. For a remote project, [connect over SSH](/term2/remote/ssh/).
The [Web Gateway](/term2/remote/web-gateway/) serves external clients such as
the separate `web-client/` app.

## Project instructions and skills

term2 discovers `AGENTS.md` or `CLAUDE.md` in the project and parent directories. It also looks for skills in `.term2/skills`, `.agents/skills`, and `.claude/skills` in project and user scope. A skill is a directory containing a `SKILL.md` file.

## Release or main?

This site tracks `main`. Check `term2 --version` for your installation and `npm view @qduc/term2 version` for the latest published release. See [what's new](/term2/getting-started/whats-new/) before relying on newer features.
