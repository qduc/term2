# Pre-publication shared package artifacts

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
adding its runtime dependency; see `docs/release-agent-wire.md`.
