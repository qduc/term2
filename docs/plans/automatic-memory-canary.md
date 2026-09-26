# Automatic memory: local interactive canary

The historical scan of 378 browsable sessions found four leads; all three
preference leads were already in active memory. Novel natural-write precision
therefore remains **unmeasured**. Do not describe this pilot as a validated
general-purpose session distiller or enable it by default.

The opt-in interactive CLI pilot is enabled with `TERM2_AUTOMATIC_MEMORY_CANARY=1`.
It makes at most one automatic project-memory write per session, with no extra
model request. `AutomaticMemoryCanary.record()` accepts one entire direct user
text turn in either exact form `Remember for future sessions: I prefer ... .`
or `For future sessions, I prefer ... .`; it rejects multiline, quoted,
credential-shaped, temporary, and longer-than-280-character input. A successful
root turn must settle without approval; replay, mixed attachments, disabled
memory, remote execution, read-only access, and active plan-mode filesystem
denial do not promote. No inferred facts or corrections are promoted. This is
intentionally narrower than automatic learning of arbitrary durable corrections.

`TurnCoordinator` emits a visible command-message receipt after the final
response with the exact quote, project memory ID, source session, `memory_get`
review call and `memory_delete` undo call. `FileMemoryStore.createAutomatic()`
records provenance and suppresses exact-title duplicates under a pilot lock;
an occupied lock or pre-existing title skips the write. A storage error disables
automatic writes for that session and emits a failure card; inspect the memory
index before retrying, because index/backup settlement may be ambiguous. The
pilot lock does **not** serialize ordinary manual writes from another process:
avoid parallel writers to the same memory directory during this pilot.

The deterministic returning-session test creates a canary record, selects it
from a fresh `MemoryCapabilityBuilder`, then removes it and verifies recall
stops. This checks storage/retrieval/undo, **not** behavioral gain from a real
returning assistant. The additional model cost on this path is zero; runtime
filesystem overhead and natural novel-write precision are not yet measured.
Before broader rollout, observe actual write yield, independently review every
receipt, stop the canary on the first incorrect write (unset the opt-in flag),
and measure returning-session answer quality and cost against a no-canary arm.
