---
name: setting-wiring
description: >-
  Wire a newly added setting so it appears in the interactive /settings UI menu
  with a description, category, and runtime-modifiability. Use when adding a new
  setting to the settings schema, when a setting was added but doesn't show up
  in the UI, or when auditing that all settings touchpoints were updated.
---

# Setting Wiring

## Objective

When a new setting is added to `source/services/settings/settings-schema.ts`, it
must be wired through six mandatory touchpoints and up to four optional ones to
appear correctly in the interactive `/settings` UI menu. A setting that is only
added to the Zod schema and `DEFAULT_SETTINGS` will be invisible or
undifferentiated in the UI. This skill is the complete checklist.

## Mandatory touchpoints

### 1. `SETTING_KEYS`

**File:** `source/services/settings/settings-schema.ts` (~line 480)

Add `MY_SETTING: 'section.mySetting'` to the constant object. Every downstream
consumer imports from this set. Forgetting this entry makes the setting
invisible everywhere.

```ts
export const SETTING_KEYS = {
  // ...
  MY_SETTING: 'section.mySetting',
} as const;
```

### 2. `DEFAULT_SETTINGS`

**File:** `source/services/settings/settings-schema.ts` (~line 651)

Add the default value under the appropriate section object. Missing this causes
the setting to be `undefined` until explicitly set.

```ts
  section: {
    mySetting: false,
  },
```

### 3. `SettingsWithSources` interface

**File:** `source/services/settings/settings-schema.ts` (~line 386)

Add `mySetting: SettingWithSource<T>` to the matching section. Missing this
causes TypeScript build errors in `formatSettingsSummary` and related tests.

```ts
  section: {
    mySetting: SettingWithSource<boolean>;
  };
```

### 4. `SETTING_DESCRIPTIONS`

**File:** `source/hooks/settings-completion-config.ts` (~line 22)

Add a description entry. Without this, the setting shows with an empty
description in the UI footer and has no description-based search matching.

```ts
  [SETTING_KEYS.MY_SETTING]: 'Description shown in the UI footer (true|false)',
```

### 5. `CATEGORY_KEYS`

**File:** `source/hooks/settings-completion-config.ts` (~line 106)

Add `SETTING_KEYS.MY_SETTING` to the appropriate category Set (`models`,
`safety`, `tools`, `ui`). Uncategorized settings fall into `misc`, which is a
hidden category that only appears during search-all mode — the setting will
not show in normal tabbed browsing.

```ts
  safety: new Set<string>([
    // ...
    SETTING_KEYS.MY_SETTING,
  ]),
```

### 6. `RUNTIME_MODIFIABLE_SETTINGS`

**File:** `source/services/settings/settings-schema.ts` (~line 559)

Add `SETTING_KEYS.MY_SETTING` to this Set if the setting should be changeable
without restart. Omit it if the setting is startup-only. The UI will still
show startup-only settings but will refuse to persist runtime changes.

```ts
export const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>([
  // ...
  SETTING_KEYS.MY_SETTING,
]);
```

## Optional touchpoints

- **`SETTINGS_CATEGORIES` / `CATEGORY_ORDER`** — `settings-completion-config.ts`
  (~line 14, ~line 156). Only if adding a brand-new category tab. Do not modify
  for an existing category. `misc` is always last and not in `CATEGORY_ORDER`.

- **`HIDDEN_SETTINGS`** — `settings-completion-config.ts` (~line 73). Add if the
  setting should be excluded from the UI entirely (e.g., provider-internal keys,
  CLI-only flags). This is for UX, not security.

- **`COMMON_SETTINGS`** — `settings-completion-config.ts` (~line 100). Add if
  the setting should be pinned at the top of every category list regardless of
  active tab.

- **`applyRuntimeSettingChange`** — `source/services/runtime-setting-router.ts`
  (~line 19). Add an `if (key === 'section.mySetting') { … }` branch only if
  changing the setting has a live side effect (e.g., reconfiguring a service,
  updating a trim threshold). Many settings don't need this — they take effect
  on the next LLM request or next session.

- **`formatSettingsSummary`** — `source/utils/settings-command.ts` (~line 23).
  Add an entry to the `entries` array only if the setting should appear in the
  plain-text `/settings` slash-command summary. The interactive menu
  (touchpoints 4–6) is the primary surface.

- **Tests** — `source/hooks/settings-completion-logic.test.ts` (category
  mapping), `source/components/menu/SettingsSelectionMenu.test.tsx` (menu
  rendering), `source/utils/settings-command.test.ts` (summary formatting). Add
  coverage for category assignment and menu visibility.

## Workflow

1. Add the setting to the Zod schema (`SettingsSchema`) and `DEFAULT_SETTINGS`
   in `settings-schema.ts`.
2. Add the key constant to `SETTING_KEYS`.
3. Add the typed field to `SettingsWithSources`.
4. Add the key to `RUNTIME_MODIFIABLE_SETTINGS` if it should be changeable at
   runtime.
5. Add a description to `SETTING_DESCRIPTIONS` in
   `settings-completion-config.ts`.
6. Assign the key to a category in `CATEGORY_KEYS`.
7. Add optional touchpoints as needed (hidden, common, side-effect handler,
   summary entry, tests).
8. Run focused tests:
   `pnpm test source/hooks/settings-completion-logic.test.ts source/components/menu/SettingsSelectionMenu.test.tsx source/utils/settings-command.test.ts source/services/settings/settings-schema.test.ts`.
9. Run `pnpm typecheck` to confirm `SettingsWithSources` is complete.

## Common mistake

The most common mistake: adding the setting to the schema and `DEFAULT_SETTINGS`
but skipping `SETTING_KEYS`, `SETTING_DESCRIPTIONS`, or `CATEGORY_KEYS`. The
setting either doesn't appear at all, appears with no description, or appears
only in the hidden `misc` category. Always run
`grep -r 'mySetting' source/hooks/settings-completion-config.ts` to confirm the
UI config was updated.

## Completion criteria

Wiring is complete when:

- The key is in `SETTING_KEYS`.
- The default is in `DEFAULT_SETTINGS`.
- The field is in `SettingsWithSources`.
- The description is in `SETTING_DESCRIPTIONS`.
- The key is assigned to a visible category in `CATEGORY_KEYS`.
- `RUNTIME_MODIFIABLE_SETTINGS` includes it (if runtime-modifiable).
- `pnpm typecheck` passes.
- Focused settings tests pass.
- The setting appears in the `/settings` interactive menu under the correct
  tab with a description.
