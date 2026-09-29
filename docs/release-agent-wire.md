# Releasing `@qduc/agent-wire`

This repository currently consumes `@qduc/agent-wire` as a workspace package,
but the root `@qduc/term2` package must remain installable without resolving an
unpublished package. The CLI build copies the compiled wire package into the
root `dist` output, so the published root tarball is self-contained.

Do not run `npm publish`, `pnpm publish`, or `git push` as part of this work.
The root release script publishes only `@qduc/term2`; publishing the wire
package is a separate, explicitly approved release operation.
