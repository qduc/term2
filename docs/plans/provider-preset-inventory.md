# Provider preset inventory

**Status:** verified and accepted by independent review (2026-10-19).

## Outcome and boundaries

Provider management lists configured connections rather than advertising unconfigured
services. Add Provider offers an alphabetized, declarative inventory and a custom
endpoint escape hatch. Preset defaults are copied into an ordinary editable draft;
saved connections do not depend on future inventory changes.

Existing built-in OpenAI/OpenRouter credentials and OAuth accounts retain their
runtime identity. This change does not migrate secrets, replace adapters, or change
authentication policy. Built-in connections retain their existing disable/account
management operations; arbitrary named connections use the existing custom-provider
storage and removal path. Native built-in adapters remain available through setup.

## Implementation sequence

1. Establish the typecheck baseline and inspect setup, credentials, and persistence.
2. Add a schema-validated JSON inventory with supported adapter defaults and explicit
   plan variants. Keep unsupported cloud authentication out of the selectable catalog.
3. Wire inventory selection into provider setup; preserve manual setup and editing.
4. Filter unconfigured built-ins out of connection management, with setup access
   retained through the inventory. Preserve selected configured-model recovery.
5. Exercise setup and persistence, invalid inventory, duplicate names, local no-auth,
   existing credentials and picker visibility. Run typecheck, lint, build and relevant
   integration/provider checks, obtain independent verification, then commit and merge.

## Acceptance and risks

- Adding a preset using an existing adapter requires JSON only: validate with a
  temporary inventory fixture and execute setup through the hook.
- Preset setup produces editable named connections: save and reload through real
  settings storage; verify duplicate names fail and two independently named copies work.
- Existing credentials and connections survive: compare persisted settings and verify
  built-in runtime identities remain unchanged.
- No unconfigured OpenAI/OpenRouter promotion: inspect rendered list and Add Provider.
- Inventory is included in built output: import the compiled catalog after build.
- No secrets or executable expressions in inventory; malformed inventory fails validation.

Settings persistence and provider setup carry high risk. Independent verification is
required; the user selected OrcaRouter (`orca`), DeepSeek V4.1 Flash.

## Independent review triage

- Route: Backspace/Delete must edit the preset filter rather than request deletion.
- Route: empty key submission must preserve a saved key, not silently erase it.
- Route: native key setup must use field-edit navigation, not the custom URL wizard.
- Accept: shared provider-list callers intentionally show configured connections;
  this is the same readiness policy as the primary provider list, not a new setup API.
- Route: include inventory IDs in search and reset selection when its query changes.
- Accept: builtin draft type assertion predates this inventory path; native saving
  ignores custom adapter type. A full native/custom draft union is outside this task.
- Accept: OAuth account setup is unchanged; live OAuth authentication and provider
  API compatibility are not verified by the inventory tests.

## Verification evidence

- Baseline and final `pnpm typecheck` passed.
- Focused filesystem/settings and terminal-input integration: 31 passed after repairs.
- `pnpm test:provider-black-box`: 215 passed, 1 skipped, 24 files; includes build.
- Compiled catalog imported from `dist`: all 25 presets loaded.
- `pnpm lint`: no errors, 31 existing warnings; `pnpm test`: 7 files, 28 passed.
- Independent Orca/DeepSeek review accepted after one rework round. Its shell
  restricted executable checks; independent evidence is source/test inspection,
  not an independently repeated test run.

Preventable review defects came from treating a new text-filter phase as a
non-editor menu and reusing a wizard key step without its field-edit context.
Blank key submission conflated unchanged and absent credentials. Terminal editing
and persisted credential regression journeys now cover these boundaries; shared
key submission preserves existing values for both native and custom editors.
Live authentication, full-app first-run onboarding, and arbitrary native connection
copies remain unverified or out of scope as described above.

## Research sources

Candidate coverage came from Models.dev and OpenCode's provider directory, inspected
2026-10-19. These establish ecosystem presence, not relative API market share.
Stack Overflow's 2025 survey supplies older model-family and local-tool adoption
signals. Inventory presence is not a claim of a successful live-provider canary.
