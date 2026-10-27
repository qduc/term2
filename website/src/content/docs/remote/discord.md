---
title: Discord Bridge
description: Opt existing terminal sessions into Discord input and explicit channel replies.
---

The optional Discord bridge connects existing opted-in interactive sessions to allowlisted Discord users and channels. It does not start a model session for you. Configure a provider and model in the terminal first.

Use `term2 discord --help` for the bridge's configuration and private token-enrollment options. The [repository bridge guide](https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md) contains the configuration schema, bot setup, first-run checklist, and offline integration command.

## Attach a terminal session

In an existing interactive session, `/bridge connect [name]` creates a local control socket and enables Discord input. `/bridge status` reports the attachment; `/bridge disconnect` detaches a socket created at runtime. Startup sockets cannot be disconnected by that command.

Alternatively, start the TUI with `--control-socket=<name> --discord-input`. A local attachment is not proof that the standalone bridge is connected to Discord. Run and configure the standalone bridge separately as described in the guide.

## Replies and local controls

Channel output requires an explicit `discord_send` call; ordinary assistant finals are not automatically mirrored. Capable, opted-in agents receive Discord communication guidance, but wording alone does not prove a message was sent. Approvals, questions, and status output remain local. Plan mode blocks Discord sends.

Offline socket/API fixtures and local attachment checks do not validate real-account Discord delivery, bot permissions, or mobile behavior. Those live checks remain outstanding; follow the guide's live checklist before relying on them.
