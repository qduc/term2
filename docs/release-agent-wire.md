# Releasing `@qduc/agent-wire`

This repository currently consumes `@qduc/agent-wire` as a workspace package,
but the root `@qduc/term2` package must remain installable without resolving an
unpublished package. The CLI build copies the compiled wire package into the
root `dist` output, so the published root tarball is self-contained.

## Later release sequence

When `@qduc/agent-wire` is ready for its first npm release, do these steps in
order:

1. Create the npm Trusted Publisher for `@qduc/agent-wire`, pointing at this
   repository and a GitHub Actions workflow that publishes `packages/wire`
   only. Configure OIDC authentication; do not create or store a long-lived
   npm token.
2. Confirm that npm exposes the released version with:

   ```bash
   npm view @qduc/agent-wire version
   ```

3. Only after that confirmation, add `@qduc/agent-wire` as a normal runtime
   dependency of `@qduc/term2` and remove the compiled `dist` inline copy and
   its embedding build step. Rebuild and rerun the root tarball smoke test.

`.github/workflows/publish.yml` currently publishes `@qduc/term2` only. The
Trusted Publisher for `@qduc/agent-wire` is not configured yet.

Do not run `npm publish`, `pnpm publish`, or `git push` as part of this work.
The root release script publishes only `@qduc/term2`; publishing the wire
package is a separate, explicitly approved release operation.
