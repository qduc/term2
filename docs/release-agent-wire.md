# Releasing `@qduc/agent-wire`

This repository currently consumes `@qduc/agent-wire` as a workspace package,
but the root `@qduc/term2` package must remain installable without resolving an
unpublished package. The CLI build copies the compiled wire package into the
root `dist` output, so the published root tarball is self-contained.

The `0.1.0` candidate and manual validation/publish workflow are prepared.
Follow [the shared package release handoff](release-agent-packages.md) for
validation, npm bootstrap if required, and the exact Trusted Publisher fields.

## Later release sequence

When `@qduc/agent-wire` is ready for its first npm release, do these steps in
order:

1. Create the npm Trusted Publisher for `@qduc/agent-wire`, pointing at this
   repository and `publish-agent-packages.yml`, with the `npm-agent-packages`
   environment and direct `npm publish` enabled. Select `wire` in the workflow
   to publish this package only. Configure OIDC authentication; do not create or store a long-lived
   npm token.
2. Confirm that npm exposes the released version with:

   ```bash
   pnpm view @qduc/agent-wire@0.1.0 version
   ```

3. Only after that confirmation, add `@qduc/agent-wire` as a normal runtime
   dependency of `@qduc/term2` and remove the compiled `dist` inline copy and
   its embedding build step. Rebuild and rerun the root tarball smoke test.

`.github/workflows/publish.yml` currently publishes `@qduc/term2` only. The
Trusted Publisher setup is a user-owned step, not performed by local preparation.

Do not run `npm publish`, `pnpm publish`, or `git push` as part of this work.
The root release script publishes only `@qduc/term2`; publishing the wire
package is a separate, explicitly approved release operation.
