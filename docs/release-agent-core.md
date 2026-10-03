# Releasing `@qduc/agent-core`

`@qduc/agent-core` is a local workspace package. The root `@qduc/term2`
package must remain installable without resolving an unpublished package.
The CLI does not currently import `@qduc/agent-core`.

The `0.1.0` candidate and manual validation/publish workflow are prepared.
Follow [the shared package release handoff](release-agent-packages.md) for
validation, npm bootstrap if required, and the exact Trusted Publisher fields.

## Later release sequence

When `@qduc/agent-core` is ready for its first npm release, do these steps in
order:

1. Create the npm Trusted Publisher for `@qduc/agent-core`, pointing at this
   repository and `publish-agent-packages.yml`, with the `npm-agent-packages`
   environment and direct `npm publish` enabled. Select `core` in the workflow
   to publish this package only. Configure OIDC authentication; do not create or store a long-lived
   npm token.
2. Confirm that npm exposes the released version with:

   ```bash
   pnpm view @qduc/agent-core@0.1.0 version
   ```

3. Only after that confirmation, add `@qduc/agent-core` as a normal runtime
   dependency of `@qduc/term2`.

`.github/workflows/publish.yml` currently publishes `@qduc/term2` only. The
Trusted Publisher setup is a user-owned step, not performed by local preparation.

Do not run `npm publish` or `pnpm publish` as part of this work. Publishing
the core package is a separate, explicitly approved release operation.
