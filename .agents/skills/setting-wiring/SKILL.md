---
name: setting-wiring
description: >-
  Wire a newly added setting so it appears in the interactive /settings UI menu
  with a label, description, tab or advanced visibility, and runtime-modifiability. Use when adding a new
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

**File:** `source/services/settings/settings-schema.ts` (~line 747)

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

**File:** `source/services/settings/settings-schema.ts` (~line 1021)

Add the default value under the appropriate section object. Missing this causes
the setting to be `undefined` until explicitly set.

```ts
  section: {
    mySetting: false,
  },
```

### 3. `SettingsWithSources` interface

**File:** `source/services/settings/settings-schema.ts` (~line 586)

Add `mySetting: SettingWithSource<T>` to the matching section. Missing this
causes TypeScript build errors in `formatSettingsSummary` and related tests.

```ts
  section: {
    mySetting: SettingWithSource<boolean>;
  };
```

### 4. Label and description

**File:** `source/services/settings/settings-ui-metadata.ts`

Add a short human-readable name to `SETTING_LABELS` (an unlabelled key falls
back to a humanized key, which is rarely what a user would call it). Give the
key a description: a schema `.describe()` text, or an entry in
`FALLBACK_SETTING_DESCRIPTIONS`. A per-key fallback beats a parent group's
description, so a group's shared text never stands in for a specific setting.
Say what changes for the user, not how it is stored: the menu strips type
hints like `(true|false)` and "in milliseconds", and shows durations and USD in
human units.

```ts
  [SETTING_KEYS.MY_SETTING]: 'My setting',
```

### 5. Visibility: a tab or advanced

**File:** `source/hooks/settings-completion-config.ts`

A setting listed in a `CATEGORY_KEYS` array (`models`, `providers`, `context`,
`safety`, `tools`, `ui`, `hooks`) appears in that browse tab, at that position
in the array — order the array for reading, most-used first, related settings
adjacent. A setting listed nowhere is **advanced**: it stays out of the tabs
but search still finds it (tagged `advanced`). Advanced is the default on
purpose — the 2026-10-19 usability audit found the tabs buried under tuning
knobs. List a setting only if a user would change it on purpose and could
explain why; timeouts, caps, thresholds, and transport details stay advanced.

```ts
  safety: [
    // ...
    SETTING_KEYS.MY_SETTING,
  ],
```

### 6. `RUNTIME_MODIFIABLE_SETTINGS`

**File:** `source/services/settings/settings-schema.ts` (~line 879)

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

- **`SETTINGS_CATEGORIES`** — `settings-completion-config.ts`. Only if adding
  a brand-new tab; seven tabs already fill an 80-column tab bar.

- **`HIDDEN_SETTINGS`** — `settings-completion-config.ts`. Add if the setting
  must not appear even in search (legacy flags, process plumbing, values owned
  by another command such as `/profile`). This is for UX, not security.

- **`SETTING_SEARCH_KEYWORDS`** — `settings-completion-config.ts`. Add words a
  user would search with that appear in neither the label nor the description
  (`cost` for the run cost limit).

- **`SETTING_ENV_VARIABLES`** — `source/services/settings/settings-env.ts`. Add
  the variable name if the setting is also read from the environment in
  `buildEnvOverrides`, so the menu can name what overrides a saved value.

- **`applyRuntimeSettingChange`** — `source/services/runtime-setting-router.ts`
  (~line 69). Add an `if (key === 'section.mySetting') { … }` branch only if
  changing the setting has a live side effect (e.g., reconfiguring a service,
  updating a trim threshold). Many settings don't need this — they take effect
  on the next LLM request or next session.

- **`formatSettingsSummary`** — `source/utils/settings-command.ts` (~line 62).
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
5. Add a label and description in `settings-ui-metadata.ts`.
6. Decide visibility: list the key in a `CATEGORY_KEYS` tab, or leave it advanced.
7. Add optional touchpoints as needed (hidden, search keywords, env variable
   name, side-effect handler, summary entry).
8. Verify (see the `verification` skill): open `/settings` in a built term2 and confirm
   the setting appears in its tab (or, if advanced, in search) with its label and
   description, and that changing it
   persists and, if runtime-modifiable, takes effect. The removed settings tests at tag
   `unit-suite-baseline` (`settings-schema.test.ts`, `settings-completion-logic.test.ts`)
   can be restored temporarily as a cross-check.
9. Run `pnpm typecheck` to confirm `SettingsWithSources` is complete.

## Common mistake

The most common mistake: adding the setting to the schema and `DEFAULT_SETTINGS`
but skipping `SETTING_KEYS` or the label and description. The setting either
doesn't appear at all or appears under a humanized key with no description.
The opposite mistake is listing a tuning knob in a tab "so people can find
it" — search already finds advanced settings.

## Completion criteria

Wiring is complete when:

- The key is in `SETTING_KEYS`.
- The default is in `DEFAULT_SETTINGS`.
- The field is in `SettingsWithSources`.
- The label and description are in `settings-ui-metadata.ts`.
- The key is in the right `CATEGORY_KEYS` tab, or deliberately left advanced.
- `RUNTIME_MODIFIABLE_SETTINGS` includes it (if runtime-modifiable).
- `pnpm typecheck` passes.
- Focused settings tests pass.
- The setting appears in the `/settings` interactive menu under the correct
  tab (or in search, if advanced) with its label and description.
