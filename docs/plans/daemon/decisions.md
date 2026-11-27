# Singleton Daemon Decision Log

Each architectural, protocol, or operational decision made during the singleton daemon program is recorded here with its date, context, options weighed, choice, rationale, and link to any follow-up in `worth-revisiting.md`.

---

## D001 — Program plan baseline and state layout (2026-11-27)

- **Context:** Starting the singleton daemon program from `docs/plans/daemon/README.md` (originating on `claude/gracious-goldberg-7pbzpv` commit `8417a42`, cherry-picked onto `origin/main` `46b7a97`).
- **Choice:** Store program state in `docs/plans/daemon/` across `README.md` (status + Resume here), `criteria-and-threat-model.md` (Step 0 & Step 6), `decisions.md` (this file), `progress.md` (step ledger), and `worth-revisiting.md` (owner review items). Subsequent design/spec artifacts (Step 7 comparison, Step 8 scenarios, Step 9 inventory, Step 10 RFC spec, Step 11 zoom notes) live in the same folder.
- **Why:** Keeps `main` always green and resumable by any fresh orchestrator session without polluting the allowlisted repository root (`scripts/check-root.mjs`).

## D002 — Execution order of Step 12 (freeze) and Step 13 (session-list prototype) (2026-11-27)

- **Context:** `README.md` lists Step 12 ("Recheck the draft spec against what the zoom-ins found, then freeze under step 5's rule") before Step 13 ("Prototype the session-list stream against the draft spec and feed what it teaches back into review before anything freezes").
- **Choice:** Run Step 13 (prototype the session-list stream and wire the web sidebar against the draft Client API spec) **before** executing the Step 12 spec freeze, then incorporate prototype learnings into the final review round and freeze.
- **Why:** Step 13 explicitly states "feed what it teaches back into review before anything freezes". Freezing before prototyping would force an immediate reopen/version bump if the first real client uncovers wire friction.
