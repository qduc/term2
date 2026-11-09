---
title: Session defaults
description: The default prompt, tools, and model controls in a term2 session.
---

A new session loads the default prompt, project instructions, the skills catalog,
and environment details. The assistant can use the shell, delegate tasks to
[subagents](/term2/modes/subagents/), and call additional tools through
`run_code` where available. Tools follow the session’s approval and sandbox settings.

Choose a model with `/model` or `Ctrl+O`, and reasoning effort with `/effort`.
There is no profile picker or mode toggle. Plan, Pair, Mentor and Orchestrator
are no longer selectable. You can ask the assistant to explain a project before proposing changes.
Tool permissions stay the same.

The internal profile backend and historical session metadata remain for
compatibility. Existing Standard/full/Lite selections normalize to the default,
and saved dropped-profile sessions restore using the existing fallback policy.
See the [backend compatibility documentation](https://github.com/qduc/term2/blob/main/docs/profiles/README.md)
for legacy inputs and stored profile identity, version and digest.
