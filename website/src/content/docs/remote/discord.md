---
title: Discord Bridge
description: Receive Discord messages and send replies from an existing terminal session.
---

Connect an existing interactive term2 session to a private Discord channel so you can send it messages from Discord. Keep the term2 session running: approvals, questions, and status remain in its terminal.

<a id="attach-a-terminal-session"></a>

## Connect your session

1. Create a dedicated Discord bot and install it in your server. Give it access to your private channel with View Channel, Read Message History, and Send Messages; enable Message Content Intent where Discord requires it.
2. Find your Discord user ID and channel ID. Create the private bridge configuration with those IDs, a fresh absolute `stateDir`, and a coordinator socket name such as `coord`. Follow the [configuration example and bot setup](https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md#discord-setup-only-after-authorization). Keep the directory user-owned and private, and do not put the bot token in JSON.
3. In a terminal, run `term2 discord --save-token` and enter the token when prompted. For a custom config path, pass the same absolute path to enrollment and startup. Enrollment saves the token beside the config and exits without connecting.
4. Start term2, finish provider setup, and open the conversation you want to use. In that session, run `/bridge connect coord`, then `/bridge status` to check the local attachment. Keep this terminal open.
5. In a separate terminal, start the bridge with `term2 discord` (or pass your absolute config path). From the allowed Discord account and channel, send a harmless request such as: “Summarize this session and send the result to this channel using `discord_send`.”

Ordinary assistant replies stay in the terminal; posting to Discord requires an explicit `discord_send` call. Check the local terminal for errors or approval prompts if no reply appears. An opted-in session can send without a per-send approval, so prompt-injected content could cause a post; only attach sessions you trust with access to the channel.

Use `term2 discord --help` for command options and the [complete first-run checklist](https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md#first-run-checklist) for bot setup, IDs, configuration and troubleshooting. Offline fixtures do not establish live Discord behavior.

To detach a socket created at runtime, use `/bridge disconnect`. A startup socket cannot be disconnected with that command. Alternatively, start the TUI with `--control-socket=<name> --discord-input`. A local attachment alone does not mean the standalone bridge is connected.

## Push Wake-up and REST Delivery

The bridge uses Discord Gateway push as a wake-up signal for cursor-based REST reads. While push is connected, the REST safety poll runs every 30 seconds instead of every second. Message content and delivery cursors still come from REST; push is not a second content source. Set `TERM2_DISCORD_GATEWAY=off` in the bridge process environment to use polling only.

Messages stay in Discord until the configured default coordinator is available.

## Replies and local controls

Channel output requires an explicit `discord_send` call; ordinary assistant finals are not automatically mirrored. An opted-in session can send without a per-send approval, so prompt-injected content could cause a post to the configured channel. Approvals, questions, and status output remain local.

See the [bridge guide’s verification notes](https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md#offline-evidence-and-optional-authorized-live-smoke) for what was tested on Discord and offline.

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
