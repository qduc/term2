# Releasing `@qduc/agent-core`

The turn harness lives in [`qduc/agent-runtime`, under `packages/core`](https://github.com/qduc/agent-runtime/tree/main/packages/core).
Term2 consumes a published prerelease through the exact runtime dependency in
[`package.json`](../../package.json). `src/session/harness.ts` adapts
Term2 sessions to that package.

Make runtime changes in the owning repository and follow its release workflow.
After the prerelease is available from npm, update Term2's manifest and lockfile
together and verify the affected journeys through Term2. Term2's publishing
workflow publishes only `@qduc/term2`.

## Retired unknown-model context patch

Term2 pinned `@qduc/agent-core@0.2.0-alpha.2` with a pnpm patch that backported
[agent-runtime PR #7](https://github.com/qduc/agent-runtime/pull/7), raising the
core's shared unknown-model scheduling assumption to 500,000 tokens. That made a
consumer's number the core's default, so the owner reverted PR #7
([#10](https://github.com/qduc/agent-runtime/pull/10)) and removed the core
default instead ([#11](https://github.com/qduc/agent-runtime/pull/11)).

From `0.2.0-alpha.3` the core exports no `DEFAULT_ASSUMED_CONTEXT_WINDOW`; its
planner schedules automatic compaction for an uncatalogued model from the host's
`Model.contextWindow`. Term2 owns its 500,000-token figure
(`UNKNOWN_MODEL_CONTEXT_WINDOW` in `src/model/provider.ts`) and supplies it as
`Model.contextWindow` for models without a catalogue capacity. Catalogue
capacities and explicit input ceilings remain authoritative; the assumption is
not a hard admission limit or evidence of provider capacity. The patch file and
its `patchedDependencies` entry are gone.

## Retired cache accounting bridge

The same alpha.2 patch also carried the owner-source cache usage and
context-price tier changes from owner commit
[`9b8a4dd`](https://github.com/qduc/agent-runtime/commit/9b8a4ddec731650264f6852be0548df8a6040c04)
in `qduc/agent-runtime`, derived from that owner's built `dist`. Those changes
were released in `0.2.0-alpha.3` (owner PR
[#8](https://github.com/qduc/agent-runtime/pull/8)). The published alpha.3
`dist` matched alpha.2 with the patch applied except for the PR #11 changes
above. Term2 adopted that release without the patch and has since advanced
the npm pin in `package.json`. The consumer still preserves raw write counts, supplies catalog
tiers and projects durable totals. Catalog costs remain estimates rounded to
integer micros per billable dimension, not provider invoice totals.
