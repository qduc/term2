# Contract 10 — Settings durability, migration, and sensitive bytes

Status: **repaired, verified, and owner-reviewed 2026-08-16.** The three authorized
non-secret repairs landed: R10.1 durable settlement through a small owner-level
API, corruption recovery through the `SettingsService` public boundary, and
durable selected-provider normalization for already-modern provider records.
President decisions 2026-08-16 (recorded below in §8): direct credential
display in `/settings` is accepted policy (R10.2 retired, replaced by a green
characterization test); plaintext credential-at-rest in `settings.json` is
accepted policy; single-level sanitization depth elsewhere is accepted.

This contract owns local durable representation and recovery: `settings.json`,
lock and temporary siblings, migration/reconciliation, and settings/provider
credential bytes. Contract 04 owns schema-to-consumer coverage, source
precedence, runtime-mutability classification, and the
`ConversationConfigurationService` transaction before runtime effects. Contract
10 does not add a settings-plus-runtime-effects transaction or change Contract
04 runtime ordering.

## 1. Contract

| ID | Observable invariant | User-visible harm prevented |
| --- | --- | --- |
| C10.1 | A durable settings mutation is reported as durable only after a committed, schema-valid replacement settles; a failed or indeterminate write is not presented as saved. | A setting or provider choice disappears after restart. |
| C10.2 | A completed replacement retains either the prior complete `settings.json` or the new complete `settings.json`. Lock acquisition respects a fresh lock for its configured wait budget and reclaims a stale-mtime lock by policy; mtime is not a proof that a holder is dead or alive. | Concurrent edits clobber or leave torn JSON, or a live holder is incorrectly assumed dead. |
| C10.3 | Startup migration is deterministic, preserves explicit current-format values, registers/normalizes the provider identity required at runtime, and records whether its durable rewrite committed. | A legacy configuration changes meaning, repeatedly re-migrates, or selects an unavailable provider. |
| C10.4 | Corrupt/schema-invalid bytes are diagnosed and never silently overwritten. Salvageable syntax corruption is recovered through the `SettingsService` public boundary with the original bytes preserved and a truthful recovered result; unsalvageable corruption and schema-invalid files remain fail-stop. | User data is lost or startup becomes an unexplained default reset. |
| C10.5 | Secret-bearing values have an explicit at-rest and display policy. No public diagnostic or settings display emits credential bytes unless an owner-reviewed policy expressly authorizes it. | API keys reach transcript, terminal scrollback, logs, or an unintended plaintext file. |

### Scope and non-claims

The writer uses a unique temp file, file `fsync`, and `renameSync` in the
settings directory. This record characterizes tested local-filesystem
replacement only. It does **not** claim power-loss or directory-entry
durability (there is no directory `fsync`), cross-filesystem atomicity,
permissions/ACL hardening, encryption/keychain storage, or crash-proof
lock-owner liveness.

Lock truth is deliberately narrow: `acquireSettingsLock` checks only
`Date.now() - stat(lock).mtimeMs > staleMs`. A fresh-mtime lock is respected
until the acquisition timeout budget expires; a stale-mtime lock is reclaimed
by policy. The lock payload's PID and token do not establish process liveness.

Corruption recovery adds no durability claim: the quarantine `renameSync`
preserves the corrupt bytes as a sibling file for diagnosis, and the fresh
replacement uses the same temp-write/fsync/rename discipline as every other
write. The scan fallback is bounded (20,000 candidate iterations) so a
pathological file cannot stall startup; when the bound is hit the file is
treated as unsalvageable and the original fail-stop path runs untouched.

## 2. Owners

| Concern | Enforcement owner | Recovery/decision owner |
| --- | --- | --- |
| Bytes, lock, temp replacement, invalid-file refusal, corruption scan/quarantine | `settings-persistence.ts` (`loadSettingsFromFile`, `saveSettingsToFile`, `acquireSettingsLock`, `scanForRecoverableJson`, `quarantineCorruptSettingsFile`) | `SettingsService` exposes settlement to mutation callers and the recovered result to startup callers; product owner chooses failure UX. |
| Schema/defaults/runtime/restart/sensitive-key classifier | `settings-schema.ts` | Settings owner; this record requires a separate credential-byte policy, not implication from `SENSITIVE_SETTING_KEYS`. |
| Merge/reconciliation/startup migrations | `SettingsService`, `settings-merger.ts`, `ancillary-settings-migration.ts`, `custom-provider-normalization.ts` | Settings owner, with provider registry owner for provider identity compatibility. |
| Credential readiness/value lookup | `utils/ai/provider-credentials.ts`, provider constructors | Provider credential owner; no provider transport change is authorized. |
| Interactive display/entry | `/settings` command, provider-management/session UI | UI command owner. Contract 04 retains ordinary runtime application. |
| Durable settlement result | `SettingsService` (`DurableWriteResult` return from `setDynamic`/`setPersistentDynamic`/`reset`, `getLastDurableWrite`) | `/settings` command renders a truthful message; product owner chooses failure UX for other callers. |

`ISettingsService` in `service-interfaces.ts` remains a consumer read/mutate
surface with `void` mutators: the durable-settlement boundary is deliberately
on the concrete `SettingsService` (return values are source-compatible with
`void` for callers that ignore them), so no consumer is forced to handle
settlement it does not use.

## 3. Execution paths sharing the contract

1. Startup: `resolveSettingsDirectory` -> raw file load -> schema validation ->
   legacy migrations/default reconciliation -> custom-provider registration ->
   optional rewrite. Corrupt-but-salvageable bytes take the scan fallback,
   quarantine, and rewrite path instead of the fail-stop throw.
2. Interactive mutation: `/settings` -> `SettingsService.setDynamic` or
   `reset` -> persist/reconcile/notification, with the durable result rendered
   truthfully. Contract 04 separately routes accepted runtime effects.
3. Restart-only mutation: trusted project roots and provider/order management ->
   `setPersistentDynamic`/`setPersistent` -> persist/reconcile.
4. Provider wizard/session: `ProviderManagementSession` -> `saveProvider` /
   `deleteCustomProvider` -> persisted `providers` -> next-start registration;
   runtime resolves the same stored credential.
5. Direct service callers and independently constructed services sharing one
   directory: lock, load-current, mutate, replacement, reconcile.
6. Environment/CLI startup overlays: merged in memory but never copied into a
   new file merely because startup occurred.

## 4. Identities and state crossing the boundary

| Identity/state | Current owner/path | Required meaning |
| --- | --- | --- |
| Durable location | `resolveSettingsDirectory()`; `settings.json`, `.lock`, unique `.tmp` sibling, `settings.json.corrupt-<ts>` quarantine sibling | One directory and replacement target; the lock token identifies only its releaser; the quarantine sibling preserves corrupt bytes verbatim. |
| Logical state | `SettingsData`, `SettingsSchema`, `DEFAULT_SETTINGS`, `SettingKey` | Full validation precedes a committed snapshot; raw bytes remain distinct for recovery/migration. |
| Resolution identity | `SettingSource`; defaults < config < env < CLI plus runtime overrides | Contract 04 owns value/source semantics; C10 prevents reconciliation from making a false durable claim. |
| Provider identity | `providers[].id`, `name`, legacy `identifier`/`displayName`, `agent.provider` | Normalize before registration; distinguish in-memory from durable migration. |
| Migration identity | former request deadline; ancillary tiers; legacy provider format; unnormalized selected provider | Raw presence decides whether a modern explicit target wins. |
| Credential bytes | Built-in OpenAI/OpenRouter keys; `providers[].apiKey`; Tavily/Exa keys; Codex token-file path | A separate byte classification. Current `SENSITIVE_SETTING_KEYS` contains only shell path and OpenRouter URL/referrer/title. |
| Durable result | `DurableWriteResult` (`saved` | `not-persisted` with `disabled`/`failed`) returned by `setDynamic`, `setPersistentDynamic`, `reset`; `getLastDurableWrite()` for transaction callers | Known saved/failed settlement at the owner boundary, without conflating Contract 04 effects. |
| Recovery result | `SettingsCorruptionRecovery` via `getRecoveryResult()` | Truthful `recovered` flag, recovery reason, preserved-bytes path, and salvaged section keys; `recovered: false` otherwise. |

## 5. Settlement semantics

| Outcome | Current observed behavior | C10 requirement / classification |
| --- | --- | --- |
| Success | Writer locks, loads a valid snapshot, validates, strips current classified fields, temp-writes + file-`fsync`s + renames, and returns committed state. Service reconciles only when it gets that value. Mutators return `{ status: 'saved' }`. | Green: a fresh service sees the durable value and stale writers preserve unrelated committed values. |
| Validation failure | Dynamic/persistent setting validates before write; the writer refuses invalid source or mutation and returns `undefined` after logging; the mutation throws a schema error before any write. | Green: caller must not receive saved success. |
| Write/lock failure | Writer logs and returns `undefined`; `setDynamic`, `setPersistentDynamic`, and `reset` mutate memory, record `{ status: 'not-persisted', reason: 'failed' }`, and notify listeners. | **R10.1 repaired:** the command renders a memory-only error line and never the unqualified saved line; the fresh service proves the predecessor remains. |
| Cancellation | No `AbortSignal`, async task, or cancelled settlement; lock wait is synchronous. | N/A; do not invent cancellation semantics. |
| Retry | Lock polls up to the configured timeout (default 2 seconds) and reclaims by mtime after the stale threshold (default 30 seconds). No automatic retry follows a save error or caller retry token. | Characterize fresh-lock wait/timeout and stale-mtime reclamation; do not equate stale mtime with dead PID. |
| Ambiguous outcome | Rename determines the low-level result; mutators now return a typed `DurableWriteResult` and `getLastDurableWrite()` exposes the same evidence to transaction callers. | R10.1 closed the public detection gap. |
| Migration | Deadline/ancillary/provider-format/selected-provider normalization is in-memory then written through the same writer when a startup migration is recorded. | Green only when a fresh service sees the normalized durable snapshot; failed rewrite is not acknowledged migration. |
| Corruption | Salvable syntax corruption: scan returns a JSON object, original bytes are quarantined to `settings.json.corrupt-<ts>`, a fresh file is rewritten, `getRecoveryResult()` reports `recovered: true`. Unsalvageable syntax or schema-invalid files: `SettingsService` refuses startup. | Green fail-stop behavior preserved; recovery is an additional, truthful path, never a silent overwrite. |

## 6. Observability and sensitive-byte handling

- Load/save diagnostics log the error string and settings path; schema
  diagnostics log issue path/message; startup logs override counts;
  `/settings <key>` prints the raw value and source.
- Recovery observability: a corrupt-but-salvageable load logs a warn with the
  settings path, recovery reason, and salvaged section keys; the service logs a
  warn with the quarantine path and a debug when the fresh replacement is
  rewritten. A failed quarantine leaves the corrupt file in place and later
  writes refuse to overwrite it (logged by the writer).
- Existing safe characterization: stripping removes `app.shellPath` and
  OpenRouter base URL/referrer/title; startup does not persist env/CLI overlays.
- Current credential-at-rest behavior is deliberately visible: stripping
  preserves `agent.openrouter.apiKey`, `agent.openai.apiKey`,
  `webSearch.*.apiKey`, and `providers[].apiKey`; provider UI stores and
  rehydrates custom API keys. Trusted-local plaintext is an owner decision, not
  evidence that those bytes are non-sensitive.
- **R10.2 retained red (public display):** one-key `createSettingsCommand`
  queries interpolate `getDynamic(key)`. Therefore
  `/settings agent.openai.apiKey` writes credential bytes to a system message.
  This characterization is intentionally limited to a direct credential leaf;
  it does not use or claim an aggregate `providers` query.
- Do not claim recursive redaction of logging/error/provider traffic without a
  concrete settings-byte path.

## 7. Public boundary under test

Primary: a real `SettingsService` with isolated `settingsDir`, exercising
`get`, `getDynamic`, `getSource`, `set`, `setDynamic`,
`setPersistentDynamic`, `reset`, fresh-service restart, the
`DurableWriteResult` returned by every public mutator, `getLastDurableWrite()`,
and `getRecoveryResult()`.

Supporting boundaries:

- `saveSettingsToFile`/`loadSettingsFromFile`/`acquireSettingsLock` for
  deterministic replacement, corruption, lock-mtime behavior, the
  `scanForRecoverableJson` fallback, and `quarantineCorruptSettingsFile`;
- `migrateLegacyAncillarySettings`, `CustomProviderSchema`, and startup service
  for migration;
- `ProviderManagementSession.save/delete`, `resolveProviderCredentials`, and
  `resolveProviderCredentialValue` for identity/credential paths;
- `createSettingsCommand.action` for durable-settlement and direct-leaf display
  policy.

Private `SettingsService.saveToFile`, override maps, and
`ConversationConfigurationService.apply` are not public test boundaries; the
latter remains Contract 04 (its mutation path is audited as a sibling in the
repair record).

## 8. Deterministic contract matrix

| Matrix cell | Exact green characterization | Status |
| --- | --- | --- |
| Initial complete snapshot | `settings-service.test.ts`: `normal operation persists settings.json when not in test environment` | green existing |
| No startup env/CLI leak | `settings-service.test.ts`: `startup does not persist CLI or environment overrides` | green existing |
| Invalid mutation | `settings-service.test.ts`: `setPersistent() rejects invalid values` | green existing |
| Invalid/corrupt persisted input | `settings-service.test.ts`: `refuses to start on invalid config file (invalid JSON)` and `refuses to start on invalid schema in config file`; persistence: `loadSettingsFromFile: hadErrors is true when file contains invalid JSON syntax` | green existing, fail-stop preserved |
| Salvageable corruption recovery | `settings-service.test.ts`: `recovers a salvageable corrupt settings file through the public boundary and preserves the original bytes`; persistence: `loadSettingsFromFile: scan fallback recovers a JSON document from trailing garbage` and `... from leading garbage`; `scanForRecoverableJson: bounded scan gives up on a pathological all-brackets file`; `scanForRecoverableJson: returns null when only a non-object value is embedded` | green repaired (red-first) |
| Atomic replacement cleanup | persistence: `saveSettingsToFile: removes its temp file when atomic rename fails` | green existing, no power-loss claim |
| Fresh lock mtime | persistence: `saveSettingsToFile: respects a fresh-mtime lock within its timeout budget without overwriting its settings file` (fresh lock plus zero timeout budget) | green existing; respects mtime policy, no liveness claim |
| Stale lock mtime | persistence: `saveSettingsToFile: recovers a stale lock and leaves a complete JSON document` | green existing; reclaims by stale mtime |
| Successor lock ownership | persistence: `acquireSettingsLock: a stale owner cannot release its successor lock` | green existing; token protects releaser ownership |
| Concurrent services | service: `persists distinct changes from independently constructed services without clobbering either` and `last committed write wins when stale services set the same setting` | green existing |
| Deadline migration | service: `migrates the former persisted request-deadline default to disabled` | green existing |
| Ancillary migration | service: `migrates legacy ancillary settings into tier settings without overwriting new values` and `startup persists migrated ancillary tier settings` | green existing |
| Legacy provider-record migration | service: `startup rewrites legacy provider format to new format in settings.json` | green existing |
| Durable selected-provider normalization (modern record) | service: `durably normalizes the selected provider when provider records already use modern ids` — rewrite persists the normalized id and a fresh service restart sees it | green repaired (red-first) |
| Durable settlement success | service: `setDynamic returns a saved settlement and a fresh service sees the durable value` | green repaired |
| Durable settlement failure | service: `setDynamic reports a failed settlement and the predecessor survives a restart`; command: `does not claim a failed durable replacement succeeded` | green repaired (R10.1 flipped) |
| Durable settlement disabled | service: `setDynamic reports not-persisted when file persistence is disabled`; command: `reports a memory-only outcome when persistence is disabled` | green repaired |
| Current classifier stripping | persistence: `stripSensitiveSettings: removes shellPath and openrouter secrets, preserving apiKey`; service: `sensitive settings are never saved to config file` | green existing, limited classifier |
| Credential-source behavior | `provider-credentials.test.ts`: `requires credentials for remote custom providers and resolves stored or type environment keys`; `preserves explicitly no-auth local custom providers` | green existing |
| Credential display | **Decided (2026-08-16): direct display is accepted policy.** `settings-command.test.ts` green test `renders direct credential bytes in /settings queries (President decision: display accepted)` replaces the former R10.2 retained red. No aggregate `providers` query is used. | green (R10.2 retired by owner decision) |
| Credential bytes at rest | **Decided (2026-08-16): plaintext local storage accepted.** Provider-session credential classes persist locally in `settings.json`; no encryption/keychain added. | decided policy (no change) |

Only the single excluded public red (R10.2) was retained; it is now retired by
the 2026-08-16 President decision above. No red is added for directory
durability, PID liveness, recursive log redaction (Contract 07 owns that), or
plaintext storage.

## 9. Verification and repair record

Repair scope (this worktree):

- `docs/contracts/10-settings-durability-migration-and-sensitive-bytes.md` and
  the contract index; production files `settings-service.ts`,
  `settings-persistence.ts`, `settings-command.ts`; tests
  `settings-persistence.test.ts`, `settings-service.test.ts`,
  `settings-command.test.ts`.

Credential-at-rest policy (2026-08-16 President decision: plaintext accepted),
display behavior (R10.2, retired by the same decision), encryption, keychain,
secret logging, lock-mtime policy, timeout/cancel semantics, or
directory-fsync claim was changed.

Repair results (base `11758c77`):

- Focused 2-file gate
  (`settings-persistence.test.ts`, `settings-command.test.ts`):
  **exit 0**, 34 passed | 1 expected fail (R10.2).
- Focused 9-file Contract 10 matrix: **exit 1** only from the known
  settings-schema baseline; 189 passed | 1 expected fail (R10.2) plus the
  pre-existing `settings-schema.test.ts` failure `disables the model-request
  wall-clock deadline by default while allowing an explicit limit` (received
  `300000`, expected `0`).
- `pnpm typecheck`: **passed**.
- `pnpm exec prettier --check <every touched file>`: **passed**.
- `git diff --check`: **passed**.
- Broader `NODE_ENV=test pnpm test`: **exit 1** from the same known
  settings-schema baseline only; 6247 passed | 1 expected fail (R10.2) |
  2 skipped | 1 baseline failure (483 files passed, 1 skipped).
- `NODE_ENV=test pnpm test:provider-black-box`: **exit 0**, 19 files, 166
  passed | 1 skipped. Required because selected-provider normalization crosses
  the settings/provider registry boundary. Two earlier full-suite invocations
  hit PTY timing flakes under machine load (load average ~5.6/8 CPUs): the
  `openai http preserves two-turn response chaining` and `Built-in OpenRouter
  executes two user turns...` scenarios timed out on their 15-second PTY
  waits; both passed in isolation (1.3s and 2.2s) against the same `dist/`
  build, and the unmodified standard command then passed in full. These are
  recorded as environment-limited timing flakes, not Contract 10 failures.

The settings-schema failure is classified as a known baseline (present at
base `11758c77` before this repair, recorded in the prior tests/docs record),
not a Contract 10 red and not introduced here. R10.2 remains the only expected
failure in the Contract 10 files.

## 10. Owner decisions, gaps, and forbidden overclaims

### Decisions resolved by this repair

1. **Durable-settlement API:** `SettingsService` public mutators
   (`setDynamic`, `setPersistentDynamic`, `reset`) return a typed
   `DurableWriteResult`; `/settings` renders a memory-only error line on
   `failed` and never the unqualified saved line. The transaction path
   (`setDynamicTransaction`) records the same evidence on
   `getLastDurableWrite()`; its runtime effects remain Contract 04.
2. **Corruption recovery:** syntactically corrupt but salvageable files are
   scanned for a JSON object, the original bytes are quarantined to a
   `settings.json.corrupt-<ts>` sibling (persistence enabled), a fresh
   replacement is written, and `getRecoveryResult()` reports the truthful
   recovered outcome. Unsalvageable syntax and schema-invalid files keep the
   existing fail-stop. No partial-start or silent overwrite is claimed.
3. **Provider identity:** when `providers[]` already uses modern ids and
   `agent.provider` still references an unnormalized identity, the
   normalization is recorded as a startup migration so the durable file is
   rewritten and a fresh service restart sees the normalized identity.

### Still requiring owner decision

- **Credential-at-rest policy:** enumerate plaintext-allowed versus
  environment-only bytes and whether keychain/encryption is in scope; align
  classifiers, stripping, wizard, resolution, and display.
- **R10.2 display repair:** redact every credential-bearing value or define a
  narrow confirmed reveal operation. Excluded from this repair by
  president-held instruction; the `it.fails` characterization is unchanged.
- **Failure UX for non-command callers:** product owner chooses how
  `DurableWriteResult` failures surface outside `/settings`.

### Classified gaps

- **R10.2 product-defect candidate (excluded):** a direct settings query
  renders a credential leaf verbatim.
- **Policy gap, not a defect by itself:** plaintext API/custom-provider
  credential persistence is observable and intended by provider UI tests, but
  its policy is undocumented/inconsistent with the word "sensitive."
- **Residual hypothesis:** directory `fsync`, crash/power-loss, permissions, and
  PID-aware locking lack evidence and are outside proven replacement.

### Forbidden overclaims

- Do not say every "sensitive" value is encrypted, env-only, absent from disk,
  or redacted: current code preserves several API-key/custom-provider fields.
- Do not say a `SettingsService` mutation is durably saved because it returned
  `void`, changed memory, or emitted `onChange`: the durable claim requires a
  `saved` settlement.
- Do not say file `fsync` + `renameSync` proves power-loss durability.
- Do not say partial-section parsing means the application starts partially:
  `SettingsService` still rejects an existing invalid file unless a scan
  salvaged a JSON object from its bytes, and then only with the original bytes
  preserved.
- Do not say a stale mtime proves a lock holder is dead, or that a fresh mtime
  proves it is alive.
- Do not say corruption recovery proves crash durability: the quarantine
  rename and the fresh replacement use the same writer discipline as every
  other write, with no directory `fsync`.
- Do not duplicate Contract 04's consumer inventory, precedence matrix, or
  runtime-effects transaction. This record consumes them only where local
  bytes meet those semantics.
