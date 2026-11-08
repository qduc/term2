# Releasing `@qduc/agent-wire`

The wire package is maintained and released from the separate
`qduc/agent-runtime` repository (`/home/qduc/agent-runtime` locally), not Term2.
Use that repository's release workflow and npm Trusted Publisher settings.

Term2 and `web-client/` consume the `0.2.2` candidate through their vendored tarball development
dependency. The CLI build embeds the installed wire package into root `dist`
so the published root tarball remains self-contained before wire is on npm.

Native web activation is still gated. This artifact accepts background task
question open/close changes and strict `WireTask.pendingQuestion` snapshots;
that fixes structural parsing, not combined native/BFF/browser acceptance. Build
any replacement from the shared repository; do not patch its tarball or copy shared
source into Term2. Update both manifests and the lockfile integrity together,
then repeat combined native/BFF/browser acceptance and independent review.

Once the wire release is visible, replace the vendored development dependency
with a normal runtime dependency. Remove the embedded copy and its build step
together, then rebuild and validate the root CLI tarball.

See [shared package ownership and handoff](release-agent-packages.md) for the
publication boundary. Term2's existing publish workflow remains Term2-only.
