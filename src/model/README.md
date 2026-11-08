# Native provider boundary

`createProviderRegistry` in `provider.ts` implements the native `ModelRegistry`
contract from `index.ts` using registered source streamed-model factories. It
owns request/item translation; the engine owns recovery admission and history.

Provider-side compaction rejection state belongs to one turn's recovery budget.
Retries within that turn share it, while concurrent turns do not. A later turn
may try compaction again, including when a previous turn found it unsupported.
Direct model requests without a recovery budget have independent state per call.

## Explicit request affinity

`ModelRequest.affinity` supplies logical history, prefix-cache and routing keys.
`createProviderRegistry` binds each request to its own provider context service,
including every async iterator step and native compaction. It never reads the
host's ambient session for provider identity. It retains the host's non-affinity
traffic metadata (start time, mode, trace ID, first-message preview and diagnostic
markers); the application's LoggingService keeps its own attribution scope. Calls without affinity receive an
independent identity per invocation; retries within that invocation retain it.

Term2 supplies root identity in `app/application-models.ts`, including native
compaction, and uses separate branch, approval-evaluator and verifier keys.
Provider adapters preserve their existing ambient-context fallback for direct
streamed-model callers; the registry always supplies explicit request scope.
Grok, OpenCode and Codex routing prefer that scope's routing key. OpenAI Responses
and Codex request bodies receive the explicit cache key where supported.

The loopback HTTP coverage in `tests/model/provider-affinity.integration.test.ts`
checks actual adapter request bodies/headers, all three OpenCode protocols,
concurrent conflicting ambient scopes, unscoped calls, advisory requests and native
compaction. Codex WebSocket identity is exercised over an injected HTTP transport;
that check does not cover a live WebSocket handshake.

## Provider ownership and registration

A Model registry owns its provider-definition snapshot, per-model transports,
request scopes and compaction rejection state. OpenAI/Codex factories return fresh
instances; their old process-wide caches are removed. Grok's version memo belongs
to its fetch middleware. Physical dispatch observers are explicit runtime
callbacks, and WebSocket send evidence is non-enumerable request-owned metadata.
The inactive ambient prefix-binding scope had no production producer; lifecycle
capture retains its previous `not_prepared` result.

Default registries load built-ins and custom provider entries from **their own
settings**. They do not inherit the process-global runtime registration table.
Existing callers that register a provider directly must pass their source registry:

```ts
import { createProviderRegistry as createSourceRegistry } from './providers/registry.js';
import { createProviderRegistry } from './provider.js';

const providers = createSourceRegistry();
providers.registerProvider(myProviderDefinition);
const models = createProviderRegistry({ settings, logger, providers });
```

The documented source registry's `registerProvider`, `upsertProvider` and
`unregisterProvider` APIs still work. Changes affect the next Model registry
created from that source; existing Model registries retain their definition
snapshot. A caller deliberately using the legacy global registration functions
can inject `{ getAllProviders }` explicitly. Term2's normal settings-based provider
configuration requires no migration. This boundary keeps two hosts with the same
custom provider ID and different endpoints independent.

## OAuth account ownership

Each provider Model registry owns its active-account map by default and exposes
`sessionAccount(providerId)` for host display and continuity policy. Its token
managers receive that map; token managers created directly own independent maps
unless their caller explicitly supplies one. A host may retain one store across
all authorized model registries of a logical session. Token managers consult that
shared pin before the credential selection, including after model or transport changes.
There is no process-wide active-account
projection. Selecting another stored account still changes the credential store's
selection, while existing token-manager instances retain their authenticated pin.

Term2's runtime record exposes the current root registry's account getter. The
attached TUI session ID selects that getter for account labels and removal notices;
configured generations replace it alongside their root model registry while
retaining the same session pin store. Advisory registries share the authentication
pin; their history, cache and transport state stay separate. Removing a pinned
account permits fallback to the selected surviving account. Account lists outside a running session report
stored selection without claiming an account is in use.

`OAuthAccountRefreshCoordinator` belongs to the application's credential owner.
Term2 shares one coordinator across its distinct session pin stores. Refreshes
queue by provider, credential-file path and account ID. Fresh credentials bypass
the queue, so a stalled account cannot block another account's reads or refreshes.
Each admitted manager rereads its pin and token freshness; a removed pin releases
its admission before acquiring the fallback account. A waiting session uses the
credential already rotated by its predecessor. Requests on the same manager
still coalesce, and a failure releases admission for a later retry. Refresh HTTP
requests time out after 30 seconds. Cancelling a caller stops its wait promptly;
an admitted rotation continues within that timeout to persist its one-use token.

A host constructing several registries directly can use the same ownership:

```ts
const refreshes = new OAuthAccountRefreshCoordinator();
const firstSession = createSessionAccountStore(refreshes);
const secondSession = createSessionAccountStore(refreshes);
const models = createProviderRegistry({ settings, logger, sessionAccountStore: firstSession });
```

Independent application instances/processes need credential-store coordination
when they share one physical credential file. This coordinator's lifetime is its
explicit application owner; the existing post-refresh stale-write checks remain.
Within one process, checking account existence and persisting refreshed tokens are
synchronous, so signing out during an in-flight refresh cannot recreate that
account. These checks do not provide an atomic transaction across processes.

`tests/model/oauth-account-ownership.integration.test.ts` exercises actual temporary
credential files through token managers, two registries and the TUI menu adapter,
including selected-account versus authenticated-account differences.
`tests/model/oauth-refresh.integration.test.ts` sends actual HTTP requests to a
loopback endpoint that consumes each refresh token once. It covers both providers,
same-session and separate-session ownership, advisory requests, account isolation,
failed-refresh recovery, independent-account liveness, cancelled waiters,
removed-account fallback and timeout recovery.

## Foreign native compaction

`history-compatibility.ts` retains the legacy input planner's lane/source check:
a foreign native compaction item is a hard refusal, because dropping it can lose
the history it replaced. Foreign reasoning alone remains droppable. Session checks
new submissions before accepting queue/turn facts, preserving the rejected draft
and allowing a switch back. The provider stream and native compact boundaries
also check before dispatch, covering auxiliary calls and non-queue callers.
Duplicate submission receipts remain valid without accepting or sending new input.
The check unwraps `provider_input` before interpreting native opaque envelopes or
markers. `historyToInput` in `provider-items.ts` applies it before either stream
or compact translation, rather than dropping foreign compaction later in an adapter.

## Flex service tier

For the built-in OpenAI provider advertising `supportsFlexServiceTier`,
`toProviderRequest` applies `agent.useFlexServiceTier` only when neither
top-level `providerOptions.service_tier` nor `extraBody.service_tier` is supplied.
The implicit flex selection must reach `extraBody.service_tier`: the shared
OpenAI Responses `requestBody` spreads that object onto the HTTP body, not the
top-level provider options. The source agent factory also supplies its flex
selection at the top level. `toProviderRequest` therefore hands any top-level
`service_tier` to `extraBody` when that body has no explicit tier. Normalizing
only the setting-derived branch misses real CLI requests because the factory's
top-level selection already suppresses that branch. Other providers, including
runtime-defined OpenAI-compatible endpoints, do not receive this implicit tier.

Explicit extra-body fields retain precedence over the top-level tier and the
implicit setting. This adapter promotes only `service_tier`, not arbitrary
top-level provider options, into wire fields on this capability-gated path.
An engine-requested `useStandardServiceTier` overrides both tier locations with
the OpenAI wire enum `default`, retaining unrelated extra-body fields.

Verification must capture the real Responses POST after loading the stored
setting through the built application, not merely inspect translated options:
setting-off, setting-on, unsupported-provider and 503-to-default recovery are
distinct controls. Explicit overrides additionally need a `ModelRegistry` probe
because the CLI does not expose request provider options.
