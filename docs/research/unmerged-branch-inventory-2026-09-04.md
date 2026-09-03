# Unmerged-branch inventory 2026-09-04 (read-only; no branch touched)

## 1. `codex/apply-patch-upstream` @ e6d32307 — NOT unmerged. Fully in main.

`git merge-base --is-ancestor codex/apply-patch-upstream main` passes. The
whole commit is reachable as `e6d32307` inside merge `ee7aeefa` ("Merge
upstream freeform apply patch tool"). The worktree at
`.worktrees/apply-patch-upstream` is a stale leftover, clean
(`git status` empty), safe to remove whenever the user wants — but removal is
a user decision; nothing to merge, rework, or review.

The untracked `docs/research/openai-codex-patch-tool.md` (primary checkout,
2026-09-02, untracked in every branch — `git log --all` has no record of it)
is the research note behind this branch: pinned to upstream `openai/codex`
`8d32abcd`, it documents the native freeform `apply_patch` grammar tool that
`e6d32307` adopted (`source/tools/file/upstream-apply-patch.ts`,
`source/tools/file/apply-patch.ts`). Owner: whoever ran the upstream survey
for this branch. Recommendation: keep alongside the merged work — `git add`
it as a docs-only commit (or delete if the user considers upstream surveys
ephemeral). It does NOT belong to `codex-no-system-input`.

## 2. `codex-no-system-input` @ 07590bef — genuine pending fix, still needed

Problem it solves (commit message + diff): local compaction stores the
checkpoint as `role: system`; Codex Responses rejects `system` in `input`
with 400 "System messages are not allowed". Fix maps system→user on the wire
in `toCodexResponsesItem` plus a fail-closed throw in
`toCodexResponsesInput` (`source/providers/codex-turn-converter.ts`,
+25/-5; tests in both converter and transport test files).

Still exists in main today (checked in code, not message):

- Producer unchanged: `local-context-compactor.ts:272,279` still builds the
  checkpoint as `{ role: 'system', ... }`; `conversation-store.ts:517`
  (`addErrorContext`) still pushes `role: 'system'`.
- Consumer unguarded: main's `toCodexResponsesInput`
  (`source/providers/codex-turn-converter.ts:14-24`) serializes `item.role`
  verbatim — no system→user mapping, no throw. The branch's fix is absent
  from the file; `git log main -- codex-turn-converter.ts` shows later work
  (`8e23bd86` native context_management, `e6d32307` upstream tool) that
  touched around it but never re-added the guard.
- Why zero errors in the logs (reconciles the audit flag): local compaction
  on the Codex path is near-dead — `agent-client.ts:270` routes
  `provider === 'codex' && mode !== 'local'` to `#compactCodexHistory`
  (native), so the system-role checkpoint is only constructed on the local
  path, which Codex-Lite sessions take; and `8e23bd86` moved standard Codex
  to native `context_management`, whose opaque item replays verbatim without
  touching the message converter. The bug is latent, not obsolete: it fires
  the moment a local compaction checkpoint (or `addErrorContext` system item)
  is serialized onto the Codex wire. The one scenario that reaches it today
  is a Codex-Lite session with local compaction — exactly the lane the
  runaway Luna work uses.

Applies cleanly? Mechanically no — `git merge-tree` reports "changed in
both" on all three files (later opaque-item rework `16353f3f`/`8e23bd86` and
the upstream-tool commit moved the same function). Conceptually the fix is
small and unobstructed: re-apply the role mapping + throw onto the current
converter shape (which now replays `provider_opaque` verbatim and must keep
doing so — the mapping applies to `message` items only). Needs a rework, not
a merge.

Blocker: nobody came back to it. Branch is a single 2026-08-30 commit on top
of `f9adc7db`, worktree clean, no failing gate recorded — it simply predates
the `8e23bd86` rework and was never rebased. The "zero errors" observation
made it look unnecessary; the code says otherwise.

## Recommendations (user decides; nothing merged/rebased/deleted)

- `codex/apply-patch-upstream`: nothing to do code-wise. Remove the stale
  worktree at leisure; decide keep-vs-delete for the untracked
  `openai-codex-patch-tool.md` (suggest: commit it docs-only — it is the
  provenance record for the merged `upstream-apply-patch.ts`).
- `codex-no-system-input`: REWORK (rebase the system→user mapping onto the
  current converter, keeping opaque replay verbatim) then merge. It is a
  latent-400 fix on the Luna-Lite path, not a dead letter. Suggested
  acceptance: regression test from the branch (system checkpoint → user on
  wire, throw on leak) passing against current main + provider-black-box.
