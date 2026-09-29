# Releasing `@qduc/agent-core`

This repository currently consumes `@qduc/agent-core` as a workspace package,
but the root `@qduc/term2` package must remain installable without resolving an
unpublished package. The CLI does not currently import `@qduc/agent-core`.

## Later release sequence

When `@qduc/agent-core` is ready for its first npm release, do these steps in
order:

1. Create the npm Trusted Publisher for `@qduc/agent-core`, pointing at this
   repository and a GitHub Actions workflow that publishes `packages/core`
   only. Configure OIDC authentication; do not create or store a long-lived
   npm token.
2. Confirm that npm exposes the released version with:

   ```bash
   npm view @qduc/agent-core version
   ```

3. Only after that confirmation, add `@qduc/agent-core` as a normal runtime
   dependency of `@qduc/term2`.

`.github/workflows/publish.yml` currently publishes `@qduc/term2` only. The
Trusted Publisher for `@qduc/agent-core` is not configured yet.

Do not run `npm publish` or `pnpm publish` as part of this work. Publishing
the core package is a separate, explicitly approved release operation.
