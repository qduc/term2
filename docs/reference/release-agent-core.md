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

## Temporary unknown-model context patch

The pinned `@qduc/agent-core@0.2.0-alpha.2` has a pnpm patch backporting
[agent-runtime PR #7](https://github.com/qduc/agent-runtime/pull/7), source commit
[`d313d1b`](https://github.com/qduc/agent-runtime/commit/d313d1bef1e461e411536de888c55f8009e54801).
It changes the shared unknown-model scheduling assumption to 500,000 tokens in
both JavaScript and its declaration. This covers the app's assumed context and
the core's conservative automatic-compaction trigger; catalogue capacities and
explicit input ceilings remain authoritative. The assumption is not a hard
admission limit or evidence of provider capacity.

The patch was derived from that source's built package. Term2 still installs the
published prerelease, with no vendored core tarball or unpublished dependency.
Remove the patch and update the pin/lockfile when a published core version
includes the source change. Package publication remains a separate operation.

## Temporary cache accounting bridge

The same published alpha.2 pnpm patch also carries the owner-source cache usage
and context-price tier changes from owner commit
[`9b8a4dd`](https://github.com/qduc/agent-runtime/commit/9b8a4ddec731650264f6852be0548df8a6040c04)
in `qduc/agent-runtime`. It preserves the existing PR #7 500,000-token assumption.
The accounting hunks are derived from that owner's built `dist` JavaScript and
declarations; Term2 does not carry a second engine implementation. The owner commit is the source provenance for the accounting bridge.

The optional public Usage counters, billable normalization, compaction accounting
and tier selection need the owner package change. The consumer preserves raw
write counts, supplies catalog tiers and projects durable totals. Publication is
separate; remove the bridge only after the pinned published version contains both
the accounting changes and PR #7. Catalog costs remain estimates rounded to
integer micros per billable dimension, not provider invoice totals.
