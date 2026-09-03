# Review: `--model` partial/fuzzy matching with interactive disambiguation

- **Scope reviewed**: `ce7a8e32..3606107b` — `source/services/models/model-resolution.ts` (new), `source/services/models/model-resolution.test.ts` (new), `source/cli.tsx`, `source/cli.integration.test.ts`, `REPORT-model-partial-match.md`.
- **Method**: full diff read, code-path tracing into `SettingsService`, `ModelCatalogSession`, `model-listing.ts`, and `subsequence-filter.ts`, plus black-box experiments against a local mock OpenAI-compatible provider in an isolated `HOME`/state dir using the compiled CLI (`node_modules/.cache/term2-cli-test-build`, built from this branch). All empirical claims below were reproduced, not inferred.
- **Verdict**: the core matching machinery is sound and well-tested, and the CLI ordering is correct. But the feature has **two high-severity regressions against existing `--model` behavior** (durable persistence of `--model` into `settings.json`, and hijacking of aggregator vendor-prefixed ids like `anthropic/...`), plus a `--json` stdout-pollution defect. The author's report does not mention any of these.

---

## Findings (most severe first)

### 1. HIGH — Every `--model` run now permanently rewrites the user's `settings.json`

`source/cli.tsx:574-580`

```ts
settings.set('agent.model', resolution.modelId);
if (resolution.provider) {
  settings.set('agent.provider', resolution.provider);
}
if (resolution.reasoningEffort && !validatedReasoningEffort) {
  settings.set('agent.reasoningEffort', resolution.reasoningEffort);
}
```

`SettingsService.set()` persists to disk unless `{ persist: false }` is passed (`settings-service.ts:677-745`: `const persist = options?.persist !== false; ... this.saveToFile(...)`). Before this change, `--model` only populated `cliOverrides` (`cli.tsx:509-511`) — an in-memory, session-only override. Now a one-off `term2 -m <pattern> "hi"` **permanently changes the user's configured default model, provider, and reasoning effort**.

**Reproduced**: with a temp HOME whose settings had `agent.model: "original-default"`, `agent.provider: "openai"`, running `--model alpha "say hi"` (single fuzzy match `mock-alpha` on a custom provider) left `settings.json` with `agent.model: "mock-alpha"`, `agent.provider: "mockprov"`. The original values were gone. This also fires on the **passthrough/offline path** (a failed catalog fetch still reaches `cli.tsx:574` and persists the raw pattern).

Why it matters: a flag that used to be session-scoped is now a durable config mutation, silently and on every invocation. The codebase knows `set()` persists by default and opts out when transient — `source/gateway/runtime-factory.ts:177` does `settings.set('agent.model', defaults.modelId, { persist: false })`, and `cli.tsx:607` does the same for the derived profile id. These three calls are missing `{ persist: false }`. The report's §1.3 ("Updates `settings` with resolved model ID...") never mentions persistence at all — this is the report's biggest omission.

### 2. HIGH — Vendor-prefixed model ids are hijacked when the vendor name collides with a registered provider id

`source/services/models/model-resolution.ts:92-105` (`parseModelFlag` provider-prefix branch) and `source/services/models/model-resolution.ts:285` (`const providerIds = deps.providerIds ?? (parsed.provider ? [parsed.provider] : undefined)`).

`parseModelFlag` treats `<knownProvider>/` as a provider prefix. OpenRouter-style ids are **exactly** of this shape — `anthropic/claude-3.5-sonnet`, `openai/gpt-4o`, `google/gemini-*` — and `anthropic`, `openai`, `google` are all built-in provider ids. On main, bare `term2 -m anthropic/claude-3.5-sonnet` (default provider `openrouter`) sent the full slash-id to openrouter and worked. After this change the string is split, `providerIds` is narrowed to `['anthropic']` so **only anthropic's catalog is loaded**, and:

- With anthropic credentials: `claude-3.5-sonnet` matches nothing in anthropic's real catalog (ids are `claude-3-5-sonnet-20241022`; the fuzzy filter can't bridge `.` vs `-`/space, verified against `filterModels`/`scoreSubsequence`) → `no_match`, exit 1. Previously worked.
- Without anthropic credentials: the fetch errors → `passthrough` (`model-resolution.ts:296-305`) → `cli.tsx:574-576` **sets provider to `anthropic` and model to `claude-3.5-sonnet`, persisted to disk** → the conversation fails with missing credentials, and the user's default provider has been rewritten.

**Reproduced**: temp HOME with default provider `mockprov` serving id `openai/curie`, no OpenAI credentials. `--model openai/curie "say hi"` exited 1 with `Unexpected server response: 401` (it tried the real OpenAI provider) and persisted `model: curie | provider: openai`. Contrast run: `--model vendor/gamma` (prefix not a known provider id) resolved exactly against `mockprov` with provider untouched — proving the failure is specifically the known-provider collision. Note the collision is not limited to built-ins: `knownProviders` includes runtime-defined custom providers (`resolveModelFlag` defaults `knownProviders` to `getProviderIds()`), so a custom provider named e.g. `together` serving ids `together/Qwen...` gets its prefix stripped too.

The report's judgment call #2 claims "If the exact slash pattern exists as a model ID in a provider, exact matching matches it directly." That is true of `matchModels` in isolation but **unreachable through `resolveModelFlag`**: `providerIds` narrowing means the other provider's group is never loaded in production. The unit test `returns exact match when full rawPattern matches a slash model id` (model-resolution.test.ts, `matchModels` describe) hand-feeds all three provider groups while `parsed.provider = 'anthropic'` — a state `resolveModelFlag` can never produce — so the test greenlights a path that cannot occur. This is the exact shape the `testing` skill warns about: the test verifies the helper, not the composed behavior.

### 3. MEDIUM — Disambiguation prompt pollutes stdout, breaking the `--json` NDJSON contract

`source/services/models/model-resolution.ts:235` and `:247` (`output.write(...)` defaulting to `process.stdout` at `:231-232`); `source/cli.tsx:557-562` passes no `streams`.

In `--json` non-interactive mode, stdout is the NDJSON event channel consumed by scripts. An ambiguous `--model` pattern writes the multi-line listing and `Select a model [1-N]: ` prompt to **stdout** before `runNonInteractive` starts.

**Reproduced**: `--json --model mock "say hi"` (stdin EOF) produced on stdout:

```
Multiple models match "mock":

mockprov:
  1) mock-alpha  Mock Alpha
  ...
Select a model [1-3]:
```

Any consumer piping `term2 --json ...` into a JSON parser receives non-JSON lines. Exit code 1 (`Cancelled.`) mitigates for consumers that check it first, but the stream contract is broken before the failure is signalled. The error/cancel messages correctly go to stderr; only the prompt text is misplaced. Writing the listing to stderr (or refusing to prompt when `--json`/non-TTY stdout and failing with an explicit ambiguity error listing the candidates) would preserve the contract.

### 4. MEDIUM — Partial catalog outage silently substitutes another provider's model (and persists it); fetch failures are never surfaced

`source/services/models/model-resolution.ts:285-323`

The passthrough safeguards only cover (a) all providers yielding zero models with errors (`:299`) and (b) zero matches **with an explicitly parsed provider** whose group errored (`:311-321`). The uncovered case: bare pattern, the provider that would serve the exact id fails its catalog fetch, but at least one other provider loads — `totalLoadedModels > 0` disables passthrough, exact match misses, and fuzzy matching happily resolves a **different provider's** model, silently. Group errors are dropped entirely — unlike `--list-models`, which prints `warning: <provider>: <error>` lines (`model-listing.ts:106-108`), `resolveModelFlag` emits nothing.

**Reproduced**: two custom providers — `brokenprov` (connection-refused port) and `mockprov` serving `openai/gpt-5.4` — with `--model gpt-5.4`. Resolution silently selected `mockprov`/`openai/gpt-5.4` and persisted `model: openai/gpt-5.4 | provider: mockprov`, with no warning about `brokenprov` anywhere on stderr. Real-world analog: user runs `--model gpt-5.4`, OpenAI's `/models` blips, OpenRouter is up → silently runs on OpenRouter and (per finding 1) makes that the durable default. On main the same invocation made no network calls and failed at request time against the configured provider — visible, retryable, not persisted.

Related, lesser: a bare-pattern `no_match` caused by the *default* provider's catalog failing (others healthy, nothing fuzzy-matching) now exits 1 before ever attempting a request, where main would have proceeded and failed (or succeeded) at request time. Fail-closed here may even be defensible, but it is a behavior change and it is silent about *why* (the error says "No models match", not "openai catalog failed to load").

### 5. LOW-MEDIUM — `--model` is now network-bound on the startup hot path

`source/services/models/model-resolution.ts:285-295` → `collectProviderModels` → sequential `ModelCatalogSession.load` per credentialed provider (`model-listing.ts:36-48`). Main's `--model` did zero network I/O. Now every invocation fetches model catalogs (in-memory cache only, per process — `model-service.ts:18,31-34`) for all credentialed providers before the session starts, unless a provider prefix narrows it to one. For a user with several configured providers and no prefix, that is N sequential HTTP GETs added to every scripted call, and a hanging `/models` endpoint stalls startup. This reuses the established `--list-models`/`/model`-picker machinery, and credential filtering (`getAvailableProviderIds`) bounds it, but the report doesn't acknowledge that an override flag became a catalog-fetching flag.

### 6. LOW — The wire-replay passthrough is load-bearing for the black-box suite and has no direct test

`source/services/models/model-resolution.ts:276-281`. The `TERM2_HARNESS_IDLE_PATH` check is the only thing that keeps `--model fixture` / `--model <recorded-id>` black-box scenarios off the catalog-fetching path; without it they'd fall through to the fetch-error passthrough anyway (fake servers don't mock `/models`), so it's a fast path — but it is itself untested (no test sets the env var; the unit passthrough tests cover only the fetch-error route). Consequently the 19-file/176-test black-box green run demonstrates that passthrough **doesn't break** wire replay, and says nothing about resolution behavior on that path. That's inherent to the design, but it should be stated: the suite's green-ness is not evidence the new matching logic works against real catalogs (the unit tests are the evidence for that).

### 7. Minor

- **Duplicated effort vocabulary**: `VALID_REASONING_EFFORTS` / `ModelSettingsReasoningEffort` (`model-resolution.ts:12-16`) duplicate `validReasoningEfforts` / the same type in `cli.tsx:409-418` (pre-existing). Two lists that can drift; the new module could have been the single source.
- **Prompt-seam inconsistency**: the injectable `prompter` path returns `null` (= `cancelled`, exit 1) on a single out-of-range answer, while the real readline path re-prompts (`model-resolution.ts:222-228` vs `:236-250`). Test-only seam, but a `prompter`-driven test can't observe the re-prompt behavior the production path has.
- **Empty pattern after suffix strip**: `--model :high` strips to an empty pattern; `filterModels` returns everything for an empty query and `scoreSubsequence('')` matches every provider name (`subsequence-filter.ts:17-23` — `qi === q.length` at 0), so the user is prompted to choose among *every* model of every provider. Edge case; on main the literal string went to the wire and failed fast.
- **Provider-name fuzzy match lists the provider's entire catalog** in the disambiguation prompt (observed: `--model mock` listed all 3 models including `vendor/gamma`). Inherited from `filterModelGroups` semantics, so consistent with `--list-models` — noting only because it makes ambiguous prompts large and is surprising when the query matched the provider, not any model.

---

## Focus-area verdicts

**1. `model-resolution.ts` does what it claims — with the two exceptions above.**
- `parseModelFlag`: thinking-suffix handling is correct — `lastIndexOf(':')`, only exact effort-vocabulary matches stripped (`:high` yes, `:batch` preserved), lowercased, whitespace trimmed; provider prefix only for known providers or explicit `--provider`, with the pattern otherwise kept whole (`anthropic/claude-3.5-sonnet` survives when `-p openrouter` is given — the working configuration). Verified by code read and by the unit tests, which are meaningful, not vacuous.
- `matchModels`: exact stage genuinely pre-empts fuzzy (`gpt-5.4` resolves silently even though `gpt-5.4-mini`/`gpt-5.4-nano` subsequence-match), and same-id-across-providers (`gpt-4o` on openai + openrouter) correctly produces two *exact* matches that disambiguate among themselves without fuzzy noise. Fuzzy stage faithfully mirrors `filterModelGroups`. The one structural defect is the unreachable cross-provider rawPattern branch inside `resolveModelFlag` (finding 2).
- `promptForDisambiguation`: real `readline` interface, re-prompts on non-numeric/out-of-range input, returns the selection; EOF/`Ctrl+C` → `null` → clean `cancelled`. Stream-injectable path covered by a PassThrough test that asserts both the header and the re-prompt message. Correct as built (stdout-channel placement aside, finding 3).
- `resolveModelFlag`: coordination and status mapping are coherent; in-memory application is correct — I specifically checked that the raw-pattern cli override (`cli.tsx:509-511`) does **not** leak into the session: `set()` records a runtime override that wins over `startupCli` in `reconcileCommittedSettings` (`settings-service.ts:1079-1096`).

**2. Regression risk vs existing `--model` behavior: two real regressions (findings 1-2), otherwise preserved.** Bare exact ids, `provider/id` with `--provider`, `id:thinking` (which, note, was **not** previously a supported syntax — nothing on main parsed the suffix; the flag passed through literally, so the new parsing is strictly additive there), and `--resume` + `-m` interplay (`cli.tsx:488`) all behave as before in-memory. Pre-existing `--model` test coverage at main was only the `--help` string and black-box scenarios (which the passthrough branch keeps green).

**3. `cli.tsx` placement: confirmed safe.** `resolveModelFlag` runs at `cli.tsx:555`, after `SettingsService` construction (`:533`) and provider validation (`:544`), before `composeAgentRuntime` (~`:7xx`), `runNonInteractive` (`:808`), and Ink `render` (`:993`). Interactive readline before Ink has precedent in the home-directory confirmation (`:380-397`), so terminal-ownership ordering is sound. Non-TTY stdin is handled gracefully: EOF at the prompt yields `Cancelled.` + exit 1 with no hang and no state change (reproduced). The gap is `--json` stdout (finding 3) and the silent persistence in exactly those scripted runs (finding 1).

**4. Test coverage: the assertions are real.** Exact-vs-fuzzy precedence has a direct test (exact `gpt-5.4` against a catalog containing `gpt-5.4-mini`/`gpt-5.4-nano` asserts `exact: true`, single match). The offline passthrough has a meaningful unit test (provider fetch error + zero models → passthrough with effort preserved). What is *not* covered: the HARNESS passthrough branch (finding 6), any test exercising `resolveModelFlag`'s provider-id narrowing (which is what hides finding 2), and the exact-slash-id test that passes only via an unreachable group configuration. The new integration test is a genuine E2E (spawns the compiled CLI, asserts exit 1 and the stderr message; `CHILD_ENV_KEYS` can't leak the harness env var into it). Note also per repo policy: **neither new test file is in `.github/vitest.lane.safe.txt`**, so `pnpm test:lane` never executed them — admission requires seeded shuffled runs first, so this is expected, but it means the lane number below covers none of the new tests.

**5. Report judgment calls**: #1 (exact precedence) sound; #2 (slash-ids) **unsound as implemented** (finding 2 — the claim is true of `matchModels`, false of the composed `resolveModelFlag` path); #3 (suffixes, `-r` precedence via `cli.tsx:578`) sound; #4 (offline passthrough) sound for total failure, silent substitution for partial failure (finding 4); #5 (prompt seam) sound for interactive ordering, incomplete for `--json`/persistence (findings 1, 3). The report is accurate about what was built but misses all three user-visible defects above, and its §4 numbers are addressed below.

---

## Gate re-runs (focus 6) — independent, not trusted from the report

| Gate | Author's claim | My run | Verdict |
| --- | --- | --- | --- |
| `pnpm test:provider-black-box` | 19 files, 176 passed / 1 skipped | **19 files passed, 176 passed / 1 skipped (177)** | **Confirmed exactly.** |
| `pnpm test:lane` | 475 files passed, 6394 passed / 3 expected fail | **Could not reproduce**: run 1 — 3 files failed / 7 tests failed / 3 expected fail; run 2 — 3 files failed / 5 tests failed / 3 expected fail, plus a recurring `logging-service` ENOENT unhandled error | Not reproduced; evidence below indicates environmental, not branch-caused |
| `pnpm typecheck` | clean | clean | Confirmed |
| New unit tests | 27 pass | 27 pass (plus 13 `model-listing` = 40) | Confirmed (run directly) |
| `cli.integration.test.ts` | 8 pass | 8 pass | Confirmed (run directly) |

**Lane-failure analysis**: the failing tests were `search-replace`/`create-file` `needsApproval` symlink/outside-workspace cases, `BottomArea` "first-run provider menu" (a 1-second-deadline timing test), and a `logging-service` tmpdir ENOENT. None of these files' module graphs reach `cli.tsx` or `model-resolution.ts`; the two file-tool failures reproduce deterministically in *isolation* in this environment (symlink-escape detection interacting with this sandbox's `TMPDIR=/tmp/qduc/term2-nodejs`), while `BottomArea` passes standalone (load flake). The branch cannot affect per-file test execution it shares no imports with, and the author's same-day lane run in this worktree passed — so I attribute my lane failures to environment, not the diff. Honest summary: **black-box numbers verified; lane 475/475 not reproduced here, with the failures provably disjoint from the change.**

---

## Recommended (smallest) fixes

1. `cli.tsx:574-580`: pass `{ persist: false }` to all three `settings.set` calls (matches `runtime-factory.ts:177` precedent).
2. `model-resolution.ts:285`: don't narrow `providerIds` to `[parsed.provider]` when the prefix came from the pattern itself (keep it for an explicit `--provider` flag), or run the exact stage across all loaded groups before narrowing — restores main's bare `-m vendor/model` behavior and makes the existing rawPattern unit test representative. Add a regression test through `resolveModelFlag` (not `matchModels`) for `anthropic/claude-3.5-sonnet` against an openrouter-like catalog.
3. Route the disambiguation listing/prompt to stderr (or fail with an explicit ambiguity error when `--json`), keeping stdout clean for NDJSON.
4. Surface group errors (like `--list-models` warnings) whenever resolution proceeds with an incomplete catalog.
