# Pre-publication shared package artifacts

The root and web-client currently pin `qduc-agent-wire-0.2.2.tgz`. The lockfile
records its integrity. The 0.2.2 artifact was built and packed from
[`qduc/agent-runtime` commit `9974343`](https://github.com/qduc/agent-runtime/commit/997434311dd0c3ad4218e6c4ded1bf3b1946a204). The 0.1.0 provenance below is historical, not the current
consumer version. Version 0.2.2 supports native task-question open/close
changes and strict `pendingQuestion` snapshots. This structural compatibility
does not authorize enabling the v2 server gate: combined native/BFF/browser
acceptance and independent activation approval remain required.

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
