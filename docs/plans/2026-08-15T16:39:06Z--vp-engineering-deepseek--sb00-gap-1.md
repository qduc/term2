[VP:ENGINEERING-DEEPSEEK] SB00_GAP_1

## Packet

SB00_GAP_1 — earned unit-test gap #1 of 4 (closure correction §7 row 1, §3.3):
`OpenAIRootProviderIdentity` 3-case characterization test. Tests only; no
production source changed.

## Evidence

- **Worktree:** `/home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity`
  (dedicated; not the inventory-closure tree). `pnpm install` clean, pnpm
  v11.7.0, linked from global store.
- **Branch:** `sb00-gap-1-openai-root-provider-identity`, forked from primary
  HEAD `11758c77`. Verified with `git -C` status: only the new test file is
  untracked; no tracked production files modified (`git diff --stat` empty).
- **Test path:** `source/services/openai-root-provider-identity.test.ts`
  (colocated, vitest, `.js` import suffix, `NODE_ENV=test`).
- **Red proof (retained before any production change):**
  ```
  RUN  v4.1.9 /home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity
  No test files found, exiting with code 1
  ```
  Captured by running `NODE_ENV=test pnpm exec vitest run
  source/services/openai-root-provider-identity.test.ts` before the file
  existed (zero coverage today, matching §3.3's verified `rg` finding).
- **Green after test only:** 5/5 passed; prettier-formatted; no production
  edit made between red and green.

## Test cases (per §3.3 recommendation, one rule per test)

1. A complete identity is frozen (`Object.isFrozen`) and readable via `current`
   (equal to the observed identity).
2. `current` is a copy — mutating the caller's object after `observe` does not
   change the retained identity.
3. **Stale retention:** an observation missing any one of
   `provider`/`endpoint`/`model` leaves `current` pointing at the previously
   retained identity (same reference) — the §3.3 harm case, not merely
   "stays null".
4. An incomplete observation with nothing retained leaves `current` null
   (gate fail-quiet on first observation).
5. A second complete identity replaces the first (last-write-wins).

## Verification commands

```
NODE_ENV=test pnpm exec vitest run source/services/openai-root-provider-identity.test.ts
```
→ Test Files 1 passed (1), Tests 5 passed (5).

No provider, bridge, run-loop, registry, or non-interactive change was made,
so the provider black-box suite is out of scope (provider-testing skill).
No commit or merge performed (packet: tests only, no C11 merge).

## needs-the-President: no
