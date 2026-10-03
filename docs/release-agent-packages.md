# Shared agent package ownership and release handoff

`@qduc/agent-core` and `@qduc/agent-wire` belong to the independent
`qduc/agent-runtime` repository, with the local checkout at
`/home/qduc/agent-runtime`. The GitHub repository must be created and pushed
separately; local extraction does not create a remote or publish to npm.

Package source, tests, tarball validation, licenses, and the publishing workflow
are maintained there, not in Term2. Follow that repository's README and release
instructions. Term2's `.github/workflows/publish.yml` publishes only
`@qduc/term2`.

## Term2 consumption before the first npm release

Term2 consumes the `0.1.0` wire candidate from
`vendor/qduc-agent-wire-0.1.0.tgz` as a development dependency. Its CLI build
copies the installed package into `dist/node_modules/@qduc/agent-wire`, keeping
the root npm tarball self-contained without depending on an unpublished package
or a sibling checkout. No shared-package build runs during Term2 installation.

After the wire release is visible on npm, switch it to a runtime registry
dependency and remove `scripts/embed-agent-wire.mjs` and its build step together.
Validate the root CLI tarball before releasing Term2.

## Core migration is a separate boundary change

The standalone core contains its own implementation source and can build
without Term2. Term2's existing runtime still uses
`source/core/session-runtime.ts` and the application-owned implementation.
The source snapshot retained there is not automatically synchronized with the
standalone repository. Changes to shared runtime behavior during this transition
need explicit coordination between the two repositories.

Replacing only `createSessionRuntime` with a package import is not sufficient:
the exported session options reference concrete collaborator classes, and
module-scoped registries and workspace state would otherwise be duplicated.
An external-core consumer migration must establish shared ownership of these
ports and state before changing the production factory. Do not use type casts
to disguise incompatible class instances or assume two module registries are
the same registry.

ChatForge's gateway-based execution does not become in-process session execution
merely because it installs the core package. Its package-consumer and runtime
changes need their own validation.

## Publishing boundary

The first candidates are `@qduc/agent-core@0.1.0` and
`@qduc/agent-wire@0.1.0`. Publishing is a separate user-assisted operation:

- Create and push `qduc/agent-runtime`, not a package workflow in `qduc/term2`.
- Configure the standalone repository's protected GitHub publishing environment.
- Confirm npm scope ownership and bootstrap each new package if npm requires it.
- Configure each npm Trusted Publisher for the **agent-runtime** repository and
  its actual workflow filename/environment, enabling direct `npm publish`.
- Run validation-only first, then explicitly select publication.

If one package publishes and the other fails, retry only the failed package.
Registry visibility can lag behind a successful publish; an immediate 404 is
not a reason to repeat a successful publication or invent another version.
