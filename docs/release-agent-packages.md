# Shared agent package release handoff

The first release candidates are `@qduc/agent-wire@0.1.0` and
`@qduc/agent-core@0.1.0`. Preparing these packages does not publish them, migrate
ChatForge off its vendored tarballs, or make Term2 import the external core.

## Local validation

From the repository root:

```bash
pnpm --filter @qduc/agent-core build
pnpm --filter @qduc/agent-wire test
pnpm test source/core/core-boundary.test.ts scripts/agent-package-release.test.ts
node scripts/agent-package-smoke.mjs
pnpm typecheck
```

The smoke command builds and packs both packages, checks their public entry
points, license, README, and core prompt assets, then installs the tarballs into
a temporary consumer outside the repository. It checks runtime imports,
registry isolation, wire envelope parsing, and public TypeScript declarations.
It installs dependencies from npm, needs network access, and cleans up its
temporary consumer. It does not publish or call a live model provider.
It is a packaging gate, not an end-to-end session execution test.

### Why the consumer check is strict

The initial core package compiled inside Term2, but its public declaration
graph referenced SQLite and sandbox types absent from the package manifest.
The monorepo supplied those types, and `skipLibCheck` hid the gap in the first
consumer check. The core now declares those dependencies, including the
sandbox's transitive node-forge declarations. Both package tarballs are checked
without `skipLibCheck`, with Node types explicitly enabled. This checks the
release boundary rather than relying on the monorepo's dependency tree; it also
covers future missing dependencies in either package.

## User-owned npm and GitHub setup

The workflow is `.github/workflows/publish-agent-packages.yml`; the existing
`publish.yml` remains the Term2-only release workflow.

Before any publish:

1. Push the reviewed preparation commits to `qduc/term2` main. This is a
   separate external action; local preparation does not push.
2. In GitHub, create the `npm-agent-packages` environment. Configure required
   reviewers and restrict deployments to main if your repository plan supports
   those protections. Merely naming an environment does not configure approval.
3. Confirm ownership of the `@qduc` npm scope and the availability of both names.
   If npm requires a first authenticated publish before a package has settings,
   that bootstrap is a separate user-assisted step using the validated tarballs.
   Do not add a long-lived npm token to this repository or its workflow.
4. For each package, configure an npm Trusted Publisher with these values:

   | Field | Value |
   | --- | --- |
   | Organization or user | `qduc` |
   | Repository | `term2` |
   | Workflow filename | `publish-agent-packages.yml` |
   | Environment name | `npm-agent-packages` |
   | Allowed action | Allow direct `npm publish` |

   The filename is not the full `.github/workflows/` path. New npm publisher
   configurations may allow staged publication without allowing direct
   publication, so explicitly enable the action this workflow uses. See the
   [npm Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Workflow behavior

Run **Prepare or publish agent packages** on main from GitHub Actions.
Leave `publish` false for a validation-only run. It runs typecheck, wire tests,
the isolated tarball smoke gate, the root build, unit tests, and integration
tests, then uploads both tarballs as the `agent-packages` artifact.

Only when publishing is explicitly selected does the second job run. It uses
the validated artifacts without rebuilding and publishes the selected `wire`,
`core`, or `both` packages with OIDC/provenance. It passes through the
`npm-agent-packages` environment. No tag or ordinary push triggers publication.

If wire succeeds but core fails, do not rerun with `both`: npm versions are
immutable. Inspect the publish output and retry only the failed package. If a
bootstrap already published `0.1.0`, do not try publishing it again; configure
Trusted Publishing for its next version instead.

A successful publish can precede npm read visibility by several minutes. An
immediate 404 is not a reason to bump the version or repeat a successful publish.

## After publication is visible

Only after registry visibility is confirmed:

- Replace ChatForge's `file:vendor/qduc-agent-*-0.0.0.tgz` dependencies with
  released package versions and regenerate its lockfile. Run its backend
  protocol/runtime tests and gateway integration tests.
- Switch Term2's wire workspace dependency to a runtime registry dependency and
  remove its embedded wire build copy together. Validate the root CLI tarball.
- Decide separately whether Term2 should import `@qduc/agent-core` externally.
  Its current session construction uses the internal source seam. Moving source
  ownership into `packages/core` and running ChatForge sessions in-process are
  not prerequisites silently included in this release.
