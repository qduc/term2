---
title: Default Experience
description: One default experience, with model selection and subagent delegation.
---

Every term2 session starts with the same default experience. It uses a minimal
prompt, local project instructions, the skills catalog and environment context.
Use the shell for codebase work and delegate bounded tasks to
[subagents](/term2/modes/subagents/). Additional capabilities are exposed through
`run_code` where available. Approval and sandbox policies still apply.

Choose a model with `/model` or `Ctrl+O`, and reasoning effort with `/effort`.
There is no profile picker or mode toggle. Plan, Pair, Mentor and Orchestrator
are no longer selectable. To start by exploring, ask the assistant to inspect
and explain a project before proposing changes; this request does not change
runtime permissions.

The internal profile backend and historical session metadata remain for
compatibility. Existing Standard/full/Lite selections normalize to the default,
and saved dropped-profile sessions restore using the existing fallback policy.
See the [backend compatibility documentation](https://github.com/qduc/term2/blob/main/docs/profiles/README.md)
for legacy inputs and stored profile identity, version and digest.
