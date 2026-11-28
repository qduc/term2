# Automatic personal memory context

A local main session can opt into sending a short snapshot headed **Personal
memories (this project)** beside a human message. `MemoryCapabilityBuilder`
uses records in the current project's memory store that carry the `personal`
tag. A checkout and its registered worktrees share a project identity through
`projectScopeKey`. A different local session in that project can receive the
same summaries. Child sessions do not receive these automatic snapshots.

## Enable or disable the snapshot

For the [built-in Bare profile](../profiles/README.md), keep memory tools and
`memory.enabled` enabled. Add this file to the host's project memory store
at `<memory.directory>/projects/<sha256(projectScopeKey(projectPath))>/personal-context.json`:

```json
{"enabled": true}
```

Bare's opt-in adds project personal summaries without adding the global index.
The setting belongs to the host-side memory store so it stays out of ordinary
search results and cannot be mistaken for a saved recollection. A missing
file or an explicit `false` turns the snapshot off. Invalid or unreadable
configuration omits it and produces a warning. Other profiles can enable the
memory context source in their profile configuration.

## When it changes

The native session planner (`planDirectHumanContext` in
[`context.ts`](../../src/session/context.ts)) reads the current snapshot when
admitting a new human turn. It records a changed snapshot as
`memory_personal_snapshot`, keyed by the admission ID, and puts a separate
application-supplied notice before the human's input to the model. Steering,
tool continuations, and replay use admitted state. On resume, the native
session fold rebuilds the notice from the stored snapshot. An unchanged
snapshot adds no new notice. When a previous snapshot becomes empty, a
replacement notice withdraws it from current context.

[`FileMemoryStore.personalContextSync`](../../src/tools/memory/memory-store.ts)
renders saved IDs and summaries, newest update first, with an omission pointer
when older entries do not fit. Full bodies and source transcripts stay in the
store. The notice fits the available `memory.contextBudgetChars` and is capped
at 2,400 UTF-16 code units including framing. For profiles with a global index,
that index is captured once per native session and uses at most half the
configured budget, up to 3,000 code units.

## Corrections and privacy

To change what appears at the next human admission, edit the record's summary
or remove its `personal` tag. Disable future inclusion for the project by
removing the Bare opt-in file or disabling it. Disabling memory also stops
memory tool access.

The selected provider receives these summaries, and Term2 can retain them in
the session record and provider-traffic logs. A withdrawal changes later
context. Prior provider requests, answers, saved snapshots, and backups may
retain what was already sent.

[Original append-only design and evidence](https://github.com/qduc/term2/blob/c455d16c56dfa1d46664c0b3183873100942bf65/docs/reference/personal-memory-context.md)
covers the pre-rewrite event format and its provider-specific checks.
