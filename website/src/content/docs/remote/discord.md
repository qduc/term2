---
title: Discord Bridge
description: Opt existing terminal sessions into Discord input and explicit channel replies.
---

The optional Discord bridge connects existing opted-in interactive sessions to allowlisted Discord users and channels. It does not start a model session for you. Configure a provider and model in the terminal first.

Use `term2 discord --help` for the bridge's configuration and private token-enrollment options. The [repository bridge guide](https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md) contains the configuration schema, bot setup, first-run checklist, and offline integration command.

## Attach a terminal session

In an existing interactive session, `/bridge connect [name]` creates a local control socket and enables Discord input. `/bridge status` reports the attachment; `/bridge disconnect` detaches a socket created at runtime. Startup sockets cannot be disconnected by that command.

Alternatively, start the TUI with `--control-socket=<name> --discord-input`. A local attachment is not proof that the standalone bridge is connected to Discord. Run and configure the standalone bridge separately as described in the guide.

## Push Wake-up and REST Delivery

The bridge uses Discord Gateway push as a wake-up signal for cursor-based REST reads. While push is connected, the REST safety poll runs every 30 seconds instead of every second. Message content and delivery cursors still come from REST; push is not a second content source. Set `TERM2_DISCORD_GATEWAY=off` in the bridge process environment to use polling only.

Ingress remains in Discord while the configured default coordinator is unavailable, rather than being consumed without a destination. These changes have offline fixture coverage, not completed live Discord/mobile acceptance.

## Replies and local controls

Channel output requires an explicit `discord_send` call; ordinary assistant finals are not automatically mirrored. Capable, opted-in agents receive Discord communication guidance, but wording alone does not prove a message was sent. Approvals, questions, and status output remain local. Plan mode blocks Discord sends.

Offline socket/API fixtures and local attachment checks do not validate real-account Discord delivery, bot permissions, or mobile behavior. Those live checks remain outstanding; follow the guide's live checklist before relying on them.

## Image attachments

New human PNG/JPEG/WebP/GIF attachments are staged privately in bridge state. The
target receives local paths and uses its existing `read_file` image tool; this is
not automatic inline vision. Use a local image-capable model/session with tools
enabled, and approve outside-workspace reads in the terminal when required.
`@worker` plus an image works without a caption. No file-read permission is granted
by Discord. Unsupported/failed media is explicitly counted instead of disappearing.

The bridge considers up to ten attachments and 20 MiB total downloaded bytes within
30 seconds per message. It fetches only validated Discord CDN attachment URLs,
without credentials or redirects. Signed URLs and original filenames are not
forwarded to the model. Image bytes go to the configured provider only through the
normal tool workflow, and may be retained in normal conversation history. Staged
files remain in private bridge state until manually removed with archived state;
protect backups and monitor disk usage. See the reference guide's **Images from
Discord** section for limitations and recovery. Live Discord and real-provider
vision behavior have not been validated by offline fixtures.
