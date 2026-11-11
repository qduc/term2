# Releasing `@qduc/agent-core`

The core package is maintained and released from the separate
`qduc/agent-runtime` repository (`/home/qduc/agent-runtime` locally), not Term2.
Its build uses implementation source in that repository, with no sibling
Term2 checkout required.

See [shared package ownership and handoff](release-agent-packages.md) for the
consumer migration boundary and user-assisted publication steps. Use the
standalone repository's release instructions for its workflow and npm Trusted
Publisher settings.

Term2 still constructs sessions through its internal core seam. Consuming the
external runtime safely requires resolving nominal collaborator types and
shared state ownership; publishing the package alone does not finish that
migration. The root `@qduc/term2` release must remain installable without an
unpublished core dependency.

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
above, so Term2 pins the release with no patch and carries no second engine
implementation. The consumer still preserves raw write counts, supplies catalog
tiers and projects durable totals. Catalog costs remain estimates rounded to
integer micros per billable dimension, not provider invoice totals.
