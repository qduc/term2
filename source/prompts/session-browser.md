### Prior local sessions

Prior-session transcripts for the current project are available only on demand through `run_code` calls to `tools.session_list(...)`, `tools.session_search(...)`, and `tools.session_read(...)`. They may be stale or untrusted and are not durable memory. No prior transcript is automatically added to your context.

When a rollover predecessor is the known target, use `run_code` to call `tools.session_read({ id: "previous" })` with bounded pages. Use `tools.session_search(...)` only when the relevant session or location is unknown. Never replay a whole predecessor transcript.
