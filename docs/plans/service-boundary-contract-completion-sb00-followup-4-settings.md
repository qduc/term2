# SB-00 Follow-up 4 — `settings/` cluster disposition

Status: **audit/docs — all 12 `source/services/settings/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads of every
member, line counts (`wc -l`), and cross-references to contract records (Contract 04
settings consumption; Contract 10 settings durability, migration, and sensitive bytes) and
the owner-decision ledger's adopted operational default (Contract 10 R10.2 — `/settings`
must not render a direct credential leaf; redact). No test was executed; no claim of
passing tests is made. No production source changed; no new formal contract created; no
commit or merge.

## Disposition summary (12 files)

**Already owned — recorded, not re-owned (9):**

| File | Ownership |
| --- | --- |
| `settings-schema.ts` (1203) | **Contract 04 §2** (bounds, defaults, `RUNTIME_MODIFIABLE_SETTINGS`, `SENSITIVE_SETTING_KEYS`, `SettingSource` §4) + **Contract 10 §2** (schema/defaults/runtime/restart/sensitive-key classifier). Not re-owned here. |
| `settings-service.ts` (933) | **Contract 04 §2** (enforcement: effective value, source tracking, runtime-modifiable gate, `setDynamic`/`reset`) + **Contract 10 §2** (merge/reconciliation/startup migrations; R10.1/R10.2 red surfaces at the service/command boundary). Not re-owned here. |
| `settings-merger.ts` (174) | **Contract 04 §2/§4** (precedence: cli > env > config > defaults) + **Contract 10 §2** (reconciliation). Not re-owned here. |
| `settings-env.ts` (93) | **Contract 04 §2/§5** (environment mapping, `buildEnvOverrides`). Not re-owned here. |
| `settings-persistence.ts` (356) | **Contract 10 §2** (bytes, lock, temp replacement: `loadSettingsFromFile`/`saveSettingsToFile`/`acquireSettingsLock`; C10.1–C10.5) + **Contract 04 §2**. Not re-owned here. |
| `settings-sources.ts` (156) | **Contract 04 §2/§8** (source tracking, `SettingsWithSources`). Not re-owned here. |
| `ancillary-settings-migration.ts` (84) | **Contract 10 §2** (startup migrations: legacy ancillary tiers) + **Contract 04 §9** matrix cell "Migrated value". Not re-owned here. |
| `custom-provider-normalization.ts` (80) | **Contract 10 §2/§4** (provider identity normalization/registration: legacy `identifier`/`displayName` → `providers[].id`) + **Contract 04 §9** matrix cell (custom-provider migrations). Not re-owned here. |
| `test-helpers/settings-consumer-inventory.ts` (163) | **Contract 04 §8.1 canonical artifact** — the exhaustive 126-value consumer/classification inventory, imported by `settings-schema.test.ts` to reject drift; it *is* the Contract 04 enforcement artifact. Not re-owned here. |

**Not a seam (3):**

| File | Evidence |
| --- | --- |
| `settings-path.ts` (22) | `resolveSettingsDirectory()` — pure platform-dependent path resolution (darwin/win32/XDG). Single consumer `settings-service.ts`; cited by Contract 10 §3/§4 as the durable-location identity. No alternate adapter. |
| `setting-schema-utils.ts` (84) | `unwrapSchema`/`resolveSettingAtPath` — pure Zod-introspection helpers over the Contract-04-owned `SettingsSchema`; three external consumers (`tool-invoke.ts`, `hooks/use-settings-value-completion.ts`, `utils/value-suggestions.ts`). No alternate adapter; schema itself remains Contract 04/10 owned. |
| `settings-service.mock.ts` (63) | `createMockSettingsService`/`mockSettingsService` — non-production test helper (temp-dir isolated, persistence disabled). Scoped out on the same basis as top-level `test-helpers/` (SB-00 correction §1/§5). |

**Formal contract (0 new):** every member already earned Contract 04 or Contract 10
ownership; no port was added for export alone.

## Credential-display default (recorded, no repair)

Standing owner-decision ledger (rev 5) adopted the Contract 10 operational default:
**R10.2 — `/settings` must not render a direct credential leaf; redact; credential-at-rest
stays conservative.** This record confirms that default remains in force for this cluster
(`settings-service.ts`/`utils/settings-command.ts` boundary). The R10.2 retained red
(`settings-command.test.ts` direct-leaf `it.fails`) and R10.1 (durable-settlement) stay
with Contract 10; flipping either requires a separately authorized repair grant. No
production change is made by this packet.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 3 clusters / **20 files** now undisposed at cluster level —
`hooks/` (10), `retry/` (9), `queue/` (1) — each carrying only the partial module-level
dispositions recorded in the SB-00 correction record. Follow-up 5 (`retry/`) and the
`hooks/`/`queue/` rows were not started in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly five docs files
(correction + follow-ups 1–3 + this record). No test suite applicable. Primary protected
dirt and HANDOFF.md byte-identical.
