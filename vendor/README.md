# Pre-publication shared package artifacts

The root and web-client pin `qduc-agent-wire-0.2.3.tgz`; the lockfile records
its integrity. The artifact was built and packed from
[`qduc/agent-runtime` commit `489272d`](https://github.com/qduc/agent-runtime/commit/489272dcef0aa3d41072248d09e7c203b92c04c0).
It includes native task-question transitions, strict `pendingQuestion`, tool
tracking and activity observation validation. Combined native/BFF/browser
question acceptance and independent activation review passed before enabling v2.
The 0.1.0 provenance below is historical.

`qduc-agent-wire-0.1.0.tgz` was built and packed from the independent
`qduc/agent-runtime` repository at commit
`b2e2ae6` (`Make standalone builds independent of parent dependency trees`).
Its upstream source snapshot is Term2 `63fbfd8a`.

This candidate is vendored so Term2 and its web client can install before the
first npm publication without requiring a sibling checkout. Do not edit the
tarball or restore shared package source inside Term2. Rebuild replacement
artifacts in agent-runtime and update the lockfile integrity when replacing one.

After the package is visible on npm, migrate consumers to registry dependencies.
For the CLI, remove the embedded wire copy and build step at the same time as
adding its runtime dependency; see `docs/reference/release-agent-wire.md`.

## @qduc/agent-core

Term2 consumes `@qduc/agent-core` as a pinned npm runtime dependency. The previous
`qduc-agent-core-0.2.0-alpha.2.tgz` was packed from agent-runtime commit
`f56a4d9` and adds tool selection control for local summaries.

`qduc-agent-core-0.2.0-alpha.1.tgz` is the turn harness that graduated from this
repository (formerly `packages/agent-harness-core/`). It was packed with
`pnpm --filter @qduc/agent-core pack` from
[`qduc/agent-runtime` commit `3e322ba`](https://github.com/qduc/agent-runtime/commit/3e322ba)
(branch `ccr-c2e20a05-677q07`). The root CLI pins it as a development dependency
was formerly shipped beside the build. Change the harness in agent-runtime,
publish a new version there, and update Term2's pin and lockfile together.
