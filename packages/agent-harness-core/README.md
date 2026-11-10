# Agent harness core

The portable, application-owned turn loop used by Term2. Hosts own history,
persistence, providers, tools, and application context. This ESM package requires
Node 24 and has no runtime dependencies. Import only
`@qduc/agent-core`; implementation subpaths are not exported.

## Running a turn

`startTurn(spec, deps)` returns a `TurnHandle`. `TurnSpec` supplies history, new
items, instructions, a model reference, offered tools, and optional model/tool
call limits. `TurnDeps` supplies model/tool registries and optional host seams.
Each invocation owns its event channel, cancellation, recovery, and tool state.

Consume `handle.events`, persist each `{ event, token }`, then call
`handle.accept(token)`. The engine waits for the delivered token before
advancing; accepting queued, old, or duplicate tokens does not advance it. The
engine never writes history. `handle.cancel()` aborts physical work and drains
known cleanup outcomes. Accepted deltas may be withdrawn during recovery; hosts
must honor those withdrawals when displaying partial output.

`Tool<Input, AppCtx>` uses JSON Schema plus `parse`, `approval`, and `execute`.
No schema-library object crosses the boundary. `ToolContext<AppCtx>.app` carries
host capabilities; signal, progress, interaction, and nested execution remain
engine-owned. Supply plain `toolContext` data or `createToolContext(binding)`
for capabilities bound to the current physical execution. A factory exception
ends the turn before the tool body starts.

## Model identity

`ModelRequest.affinity` and `TurnSpec.affinity` carry provider identity explicitly:
`conversationKey` selects logical history, `cacheKey` selects prefix-cache affinity,
and optional `routingKey` selects the sticky server or transport (defaulting to the
cache key, then conversation key). History can rotate while cache/routing keys stay
stable. Hosts give nested and advisory requests their own identity; `startNestedTurn`
accepts affinity with its turn ID. The engine carries it through retries and both
local and native compaction. The fields are host inputs, not history or events.

## Host seams

| Seam | Contract |
| --- | --- |
| `prepareRequest` | Before every model dispatch, receives the request plus turn ID, model step, and signal. Returns the live request and optional tool registry. Stored history stays unchanged. |
| `takeSteering` and `handle.steer()` | Admit new user items at the next request boundary; do not interrupt a response in flight. |
| `interaction_required` and `handle.answer()` | Approval or question waits for the matching answer. An unanswered request waits until cancellation; hosts own timeout policy. |
| `normalStop` | After a model response without tool calls, stop or continue with a reminder. |
| `runNested` | Host assigns child identity and lifetime, runs the same loop, and returns its result. The host routes child interactions. |
| Event acceptance | Every emitted receipt is acknowledged only after the host durably accepts its event. |

A throwing request/steering/stop seam ends the turn; a slow seam delays progress.
Cancellation reaches seam implementations through their supplied signals.
`onTurnBoundary` observes dispatch, parking, cancellation, and termination.

## Opt-in helpers

Compaction remains inside the driver for now. `startCompaction` runs only the
compaction path; history replacements take effect after host acceptance. Budget
policy and continuity are optional. A host can supply `accounting` pricing and
subscription callbacks; without them, actual provider charges are retained and
unknown rates stay unpriced. No provider catalog or host settings are loaded.

`startNestedTurn` scopes offered tools and enforces native branch limits. Hosts
own tool-name policy; Term2 applies its root-only tool restriction in Session.
The public continuity, tool-pair repair check, context policy, budget, and cost
helpers support Term2's host modules. Shared `ModelFailure` and retry error/budget
constructors let adapters supply live recovery evidence without losing class
identity across the package boundary. Engine driver classes and compaction
implementation helpers remain private.

## Workspace and distribution

The package incubates in this workspace (directory `packages/agent-harness-core/`)
and is embedded in Term2's distribution. Prereleases go to npm under the `next`
dist-tag (`publishConfig` sets it), so `npm install @qduc/agent-core` without a
version or tag installs nothing until a stable release exists; consumers pin an
exact prerelease version. `0.1.0` was used by an earlier, unpublished snapshot
and cannot be republished. `pnpm build:core` builds its JavaScript and
self-contained declarations; `pnpm build` builds it before Term2 and embeds it
under `dist/node_modules`. Build receipts cover package source and configuration. `pnpm dev` watches both
the package and Term2, so edits to package contracts rebuild their consumer.
Watch mode uses the Node-based compiler because native fanotify watching is not
available on every workspace filesystem.

`tests/engine/agent-harness-package.integration.test.ts` compiles current package sources into an isolated staging directory, packs that
output, and installs the tarball into a separate plain JavaScript project, and runs two
concurrent turns with distinct settings and application contexts through the
public entry point. Existing Term2 integration and e2e tiers exercise the first
consumer.
