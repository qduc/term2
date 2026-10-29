# Automatic personal memory context

Normal root agents with memory tools and the profile's memory context source
both enabled receive a short **Personal memories (this project)** snapshot beside
the next human message, not in leading model instructions. Bare defaults stay unchanged, but an explicit project-local
opt-in can enable only this section in Bare. Subagents do not receive it.
The global index remains a session-start snapshot.

`MemoryCapabilityBuilder.build` selects only the current project's records
explicitly tagged `personal`. The nightly personal-memory job already uses that
tag; manual memories can use it too. Other project memories remain available
through retrieval, not automatically injected by this feature. Project identity
uses the existing `projectScopeKey` contract: a checkout and its worktrees share
a store; unrelated projects do not. This is project scope, not a particular
coordinator, Discord channel, or person: any enabled root session in that project
can receive these summaries (Bare also requires the opt-in below).

## Bare: explicit project-local opt-in

Bare can receive personal summaries without switching to Standard or importing
its global memory index, instruction fragments, or other context. Place this
JSON file in the **project memory store**, not the global memory directory or
repository: `personal-context.json` containing `{"enabled":true}`. The store is
`<memory.directory>/projects/<sha256(projectScopeKey(projectPath))>/`; use the
same identity as existing memory tools, including checkout/worktree sharing.
The file is host-local configuration, not a memory record or an instruction.
It does not alter saved profile selection or tool/approval authority.

The Bare resolver checks this file when admitting human input. Missing/false means
no current personal snapshot. Invalid or unreadable configuration omits personal
context with a fixed warning; it never enables on a truthy string. Removing the
file or setting `enabled` false withdraws the automatic snapshot at the next human input in Bare. It does not
turn off the ordinary memory context source in Standard. `memory.enabled` and
the memory tool capability remain kill switches in either profile. Other
profiles with their memory context source disabled are not opted in by this
Bare-specific exception.

The alternative, switching the coordinator to Standard, would import unrelated
behavior and is not required. A specially named control memory was rejected:
configuration should not masquerade as an emotional memory or enter retrieval.
No global setting or new model call is added. Existing Bare sessions require a
normal restart/resume into the new code, with the **same Bare profile**; after
that, opt-in changes take effect at the next human input without another restart.

## Timing and size

`getAgentDefinition` exposes a separate `resolvePersonalContext` hook. The
conversation record captures it when admitting timestamped human input; runtime
steering captures it at its admission boundary too. Tool continuations and replay
do not read today's store. If the rendered snapshot is unchanged, nothing is
added. A changed snapshot is persisted on that human item and normalized into a
separate user-role **application-supplied data** notice immediately before the
human message (and any existing timing notice). Human text is not concatenated
with memory; existing steering framing is unchanged.

The notice declares a full replacement: unlisted entries are no longer current
automatic context, including recollections retained in summaries. Disabling the
feature, deleting the last eligible entry, or a failed read after a nonempty
snapshot produces one withdrawal notice; unchanged empty state produces none.
This is semantic supersession, not erasure or an instruction/approval grant.
No extra model call, timer, digest file, or per-turn refresh event is added.

Saved `personal_memory_context` events attach snapshots by host human-input
timestamp, including when a steering event precedes its user log row. Resume
reuses those exact snapshots, never reconstructing old turns from current memory.
Local checkpoints retain the comparison state in protected human items. Native
Codex checkpoints carry application-only comparison metadata; it is stripped
before provider serialization, so an unchanged post-compaction turn adds no notice.
The existing manual native-compaction path does not journal its opaque checkpoint:
a restart restores the original history instead. Snapshot events still restore
correct changed/withdrawn state; this feature does not repair general compaction
persistence.

Unchanged historical provider messages and leading instructions are not rewritten
when personal memories change. Codex chaining keeps the entire trailing user block,
including the data notice, rather than only the last human message. This preserves
prefix eligibility; it does **not** guarantee a backend cache hit or measured token
savings. Installing this version changes the old leading-instruction layout once;
existing sessions without snapshot events receive their first current snapshot at
the next human input.

`FileMemoryStore.personalContextSync` reads the current index and renders saved
IDs and summaries as JSON bullet lines, newest `updatedAt` first (ID breaks
ties). It does not rewrite, interpret, or merge their meaning. Full bodies,
source transcripts, titles, and provenance are not copied. Bare has no injected
global index, so its opted-in personal section can use the full configured
budget (minus the reserved separator), up to the same 2400-character cap. A nonempty
notice is capped at **2400 UTF-16 characters**, including the application wrapper,
section heading, framing, and omission pointer. It also fits the remaining `memory.contextBudgetChars` after the pinned
global index and a two-character separator. The global index gets at most half
the configured budget, capped at 3000 characters, so a small configured budget
cannot be consumed entirely by global memories. That existing setting defaults to
8000. It is not a token limit or a limit on the whole system prompt.

Only complete summaries are admitted, as a contiguous recency prefix; older
omissions are counted with a retrieval pointer. With too little space even for
the framing/pointer, no section is emitted. A previously supplied section still
gets a small fixed withdrawal notice even when the configured budget is lowered. No memory is changed or deleted by
this bound. A missing store yields no section. A corrupt/unreadable index yields
no section plus a warning, rather than blocking the request; later human inputs retry
the read. Warning text does not include saved summaries.

## Corrections and privacy

A new personal-tagged memory, an updated **summary**, tag removal, or deletion
changes the snapshot at the next human input. An edit to the full body alone does not
rewrite its saved summary: update the summary too when correcting the short
recollection. A request already in flight is not changed retroactively; tool-only continuations
keep the admitted snapshot until another human input arrives.

After installing a build containing this feature, restart and resume an existing
session normally to load the new code. No memory migration, special retrieval
prompt, or new session is required. A still-running old binary does not gain the
feature. This feature does not restart any coordinator or modify automation.

Personal summaries now travel automatically to the session's selected provider
and are persisted with conversation snapshots and may appear in provider-traffic logs, even for a task unrelated to those
moments. Do not tag information `personal` unless it is suitable for that
project's normal model context. To stop future personal injection, remove that
tag (keep the record), delete the record deliberately, or disable memory context
in a non-Bare profile / memory tools / `memory.enabled`. Bare users can also
remove/disable the project opt-in file. Disabling memory tools also
removes memory tool access. Existing global-memory behavior remains separate.

The heading treats saved text as contextual data, not authority or verified
current fact, and warns against inventing feelings or enduring traits. JSON
escaping prevents a summary's newline/quote from becoming another bullet or
heading; it is not a security guarantee that a model cannot follow malicious
text. Third-party requests quoted in memories do not become current user
instructions.

Removing a tag/deleting a record stops **future automatic inclusion**, not prior
provider exposure, prior model answers, retained logs, or other copies such as
nightly evidence/backups. This is not a retroactive erasure mechanism. Ordinary
memory tooling and the nightly job's own retention/privacy rules still apply.
