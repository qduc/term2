# Releasing `@qduc/agent-core`

The core package is maintained and released from the separate
`qduc/agent-runtime` repository (`/home/qduc/agent-runtime` locally), not Term2.
Its build uses implementation source in that repository, with no sibling
Term2 checkout required.

See [shared package ownership and handoff](release-agent-packages.md) for the
consumer migration boundary and user-assisted publication steps. Use the
standalone repository's release instructions for its workflow and npm Trusted
Publisher settings.

Term2 still constructs sessions through its internal core seam. Consuming the
external runtime safely requires resolving nominal collaborator types and
shared state ownership; publishing the package alone does not finish that
migration. The root `@qduc/term2` release must remain installable without an
unpublished core dependency.
