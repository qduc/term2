# Profile activation, persistence, and trust

## Activation boundary

Resolution is pure; activation owns effects. A Profile transition service takes
the current and target resolved Profiles and produces one atomic transition or
no change.

Activation responsibilities are:

1. Resolve and validate the target Profile.
2. Compare behaviorally relevant resolved sections.
3. Classify the transition.
4. Obtain any existing mid-session confirmation through the application UI.
5. Prepare affected agent composition and required integrations without making
   them visible as active.
6. Commit the canonical selection and prepared runtime composition together.
7. Queue the correct next-turn notice, if any.
8. Break provider continuity when the existing compatibility rules require it.
9. Project one coherent UI and persistence update.
10. Dispose replaced runtime resources after the new composition owns the
    session.

Failure during preparation leaves the current Profile and its runtime resources
active. Activation MUST NOT publish new settings, guards, integrations, or UI
identity before all required preparation succeeds. Failure after the commit is
handled by the owning session/runtime recovery path and must not restore disposed
resources as though rollback were still possible.

## Transition classification

Profiles cannot self-declare a transition safe. term2 derives the class from the
resolved semantic delta and provider state.

Initial classes are:

- **presentation-only** — no model/runtime semantic change;
- **notice-only** — stable prefix and tool shape; workflow changes on the next
  real user turn;
- **agent rebuild** — root instructions, context construction, tool surface, or
  integration wiring changes;
- **new chain or session required** — current provider history cannot safely
  continue with the changed definition.

Enforcement may become stricter immediately when existing guards can install it
atomically. Relaxing a Profile restriction still remains bounded by global
authority and follows the rebuild/continuity classification required by the
affected tool surface.

Milestone 1 MUST preserve the current distinction:

- Plan, Mentor, and Orchestrator deliver active workflow instructions through a
  next-user-turn `<system-notice>` so their common non-Lite prefix remains
  stable.
- Lite changes the base prompt and tool construction and therefore remains a
  structural switch subject to current history protection.

## Notice semantics

The transition service renders notices from the old and new Profiles rather
than toggling independent booleans. A transition has one coherent notice
payload; sequential exit and enter writes must not overwrite one another in the
single pending-notice slot owned by the session lifecycle.

The notice is prepended to the next real user turn and then consumed exactly
once, preserving the behavior owned by the session input preparation path.

Starting or restoring a conversation with a notice-driven Profile active queues
that Profile's enter notice as `primeActiveProfileNoticeIfActive()` does.

## Commands and UI

The canonical command is:

```text
/profile <profile-id>
```

Milestone 1 retains aliases:

```text
/lite          builtin:lite ↔ builtin:standard
/plan          builtin:plan ↔ builtin:standard
/mentor        builtin:mentor ↔ builtin:standard
/orchestrator  builtin:orchestrator ↔ builtin:standard
```

Activating one Profile inherently replaces the current Profile; mutual
exclusion no longer requires normalization among boolean flags.

`Shift+Tab` preserves its current Standard/Plan cycle during Milestone 1. The
banner, status bar, resume picker, gateway projection, and provider-traffic
context derive their labels from the active resolved Profile.

## Canonical settings state

The runtime and settings system expose one canonical value:

```ts
interface AppProfileSettings {
  activeProfileId: string;
}
```

Legacy mode settings may be accepted at configuration, gateway, or saved-data
boundaries during migration. A compatibility adapter converts them immediately
to a Profile ID. Core consumers MUST NOT retain both representations or decide
precedence independently.

Legacy malformed-state precedence remains:

```text
Orchestrator > Lite > Plan > Mentor > Standard
```

Writing a legacy compatibility field maps to Profile activation; it does not
set a parallel flag.

## Conversation persistence

New conversation state records at least:

```ts
interface SavedProfileSelection {
  id: string;
  version: string;
  digest: string;
}
```

The persistence schema reserves a resolved semantic snapshot for externally
loaded Profiles. Milestone 1 built-ins ship with term2, so snapshot persistence
may be deferred until the first custom-Profile milestone, but decoder and replay
types must not make that addition ambiguous.

Legacy `SavedAppMode` maps to the corresponding built-in ID. Old saves remain
readable; new saves use Profile identity and do not emit the four booleans as
canonical state.

When custom Profiles ship, resume behavior will be:

- matching installed ID and digest: use the installed definition;
- same ID with a different digest: use the saved resolved snapshot and surface
  the mismatch;
- missing installed Profile: use the saved snapshot and surface missing
  provenance; and
- snapshot incompatible with the current schema: refuse unsafe restoration
  with an actionable error.

Snapshots exclude credentials, resolved secrets, selected model, and global
security settings.

## Provenance and discovery

Future discovery roots are:

```text
term2 installation profiles     builtin provenance
user config profiles            user provenance
<project>/.term2/profiles       project provenance
```

Milestone 1 implements built-in provenance only. Later discovery obeys these
rules:

- project Profiles are discovered but never activated automatically;
- user and project IDs cannot shadow built-ins;
- the UI displays provenance;
- Profile-local paths cannot escape the Profile root;
- remote references are not fetched during discovery or activation; and
- installation is an explicit user action outside Profile activation.

## Authority and trust

A Profile is selected configuration, not trusted executable code. Selection may
alter model-visible instructions and eligible tools, but effective execution is
still bounded by existing application authority.

Profiles MUST NOT:

- disable approval checks;
- enable global auto-approval;
- disable the sandbox;
- widen filesystem or network scopes;
- widen a child beyond parent permissions;
- create executable tools, guards, hooks, or integrations;
- execute context-generation scripts;
- interpolate secrets or arbitrary environment variables; or
- install dependencies.

Tool visibility and authority remain distinct. Enforcement composition is
monotonic: a Profile can add a registered restriction but cannot remove an
inherited or global restriction.

## Observability

Logs and provider-traffic context record:

- active Profile ID;
- version and digest when available;
- provenance;
- transition classification;
- resolution or activation failure category; and
- legacy migration source when a saved mode or compatibility setting was used.

They MUST NOT record Profile document contents merely for diagnostics. Existing
prompt/provider logging policy continues to govern content that is actually sent
to a model.
