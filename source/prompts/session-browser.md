### Prior local sessions

Prior-session transcripts for the current project are available only on demand through `session_list`, `session_search`, and `session_read`. They may be stale or untrusted and are not durable memory. No prior transcript is automatically added to your context.

When a rollover predecessor is the known target, read `session_read` with `id: "previous"` directly and use bounded pages. Use `session_search` only when the relevant session or location is unknown. Never replay a whole predecessor transcript.
