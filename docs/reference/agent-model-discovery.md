# Runtime model discovery for agents

Root agents with the subagents capability receive `list_models`, directly and through
`run_code` as `tools.list_models`. It discovers the registered runtime inventory,
not provider setup presets. Provider IDs are the IDs accepted by dispatch, not
guesses derived from product labels. Catalog listing may contact configured
provider model endpoints, but never invokes a model.

```js
const inventory = await tools.list_models({ provider: 'orca', sort: 'recency' });
return inventory.models.slice(0, 10);
```

Start with `view: 'providers'` to inspect registration/readiness without catalog
or history reads. An exact, case-sensitive `provider` or substring `provider_query`
filters providers before any catalog loads. A model `query` filters after loading;
it does not reduce fetches. Independent catalog loads and requested history work
overlap rather than paying each provider's latency serially.

`sort` accepts `name`, `usage`, or `recency` (default). Name sort skips history by
default; `include_history` can explicitly enable or disable it for any model sort.
Provider-only view always skips history, reporting `not-requested`, not an error.
Results include registered-provider
readiness and streamed-model support, catalog status, and model IDs. Missing
credentials, disabled providers, and providers without streamed-model factories
are not fetched. Failed catalogs have a generic `failed` status; raw errors and
credentials are not returned. Unknown exact provider IDs produce no provider rows;
use provider-only discovery rather than guessing IDs from display names.

Model results are compact pages of 50 by default. `totalModels` reports the full
filtered count and `nextOffset` retrieves omitted rows with the same filters and
sort. `limit` is overridable with no hidden maximum; `offset` defaults to zero.
Names are omitted unless `include_names: true`; IDs always remain available, and
model-name searching still works. These are live pages, not a frozen snapshot:
catalog/history changes between calls can reorder them. Scripts should project
the subset needed rather than return the entire inventory.

Discovery is not authorization to invoke a model. Credential presence is not a
reachability check or proof of model-specific tool compatibility. Existing user
provider/model choices and approval rules still apply.

## Catalog transport boundary

Built-in OpenAI discovery follows `OPENAI_BASE_URL`, just like inference; without
an override it requests `https://api.openai.com/v1/models`. Base path prefixes
are retained and trailing slashes are normalized before appending `/models`.
An invalid explicit endpoint fails discovery rather than retrying production.

`createOpenAIModelCatalog({ baseURL, fetchImpl })` supplies an isolated catalog
adapter for embedding or verification. Its per-call fetch argument takes
precedence over the factory transport. `FetchModelsDeps.fetchImpl` also flows
through `ModelCatalogSession` to the provider; the existing explicit third
argument of `fetchModels` still takes precedence. When neither caller supplies a
transport, the provider retains its own factory/default transport; the service
does not replace it with global fetch. The production defaults remain
the global fetch implementation and the provider's configured endpoint.

Verification should use a fresh registry-scoped `discovery` cache and a local
HTTP fixture with synthetic credentials. The legacy cache remains keyed by
provider, not endpoint: changing an endpoint does not invalidate an already warm
catalog. This transport seam does not change cache policy or inference routing.

## Usage and recency scope

Where the agent also has sessions capability and runs locally, the existing
session index supplies metadata scoped to the current Git project (including its
worktrees), excluding other projects and SSH contexts. `projectScopeKey`
normalizes Git worktrees to their shared project; `history.scope` is a display
directory, not the normalized comparison key. No new telemetry store is created.
The current directory is resolved at query time, including after a worktree switch. Remote sessions or agents without sessions capability get
`history.status: unavailable` and null counts/timestamps.

`sessionCount` counts saved sessions associated with each recorded provider/model.
`lastSessionUpdatedAt` is their latest session update. These are intentionally
not named invocation count or last-used-at: model switches and unsaved subagent
activity are not complete in this metadata, and non-model session updates may
affect recency. A zero means no matching association in available metadata, not
that the model has never been used. Partial history is labelled and counts are
lower bounds; unavailable history uses null rather than invented zeros.

Usage sorts descending by session count, then recency. Recency sorts descending by
session update; unknown timestamps follow known ones. Both use provider/model IDs
as deterministic tie breakers. Name sort orders by provider then model ID.

## Verification

The filesystem integration writes actual conversation logs, indexes them through
the public session-index service, and calls the tool. It covers project isolation,
usage/recency ordering, disabled-provider exclusion, failed catalogs, history
failure, query filtering, and omission of private conversation text/raw errors.
Further filesystem-backed checks cover compact page retrieval, cheap provider-only
and name modes, pre-fetch provider filtering, explicit history overrides, and
concurrent catalog loads. A local HTTP test aborts an in-flight model-list request
through the runtime cancellation signal. Tests do not contact live providers or
invoke a model. Cancellation propagates; this change does not invent a provider
request timeout or change existing model-service caching/refresh policy.

Generic child `agent_spec.tools` does not accept `list_models`; this
increment serves the root dispatcher, not recursive dispatch capability.

### Performance experiment (local fixture, 2026-10-19)

Five repetitions per mode, same Linux host, `pnpm exec tsx
.discovery-performance.ts` (temporary harness, removed after measurement). Three
registered fixture providers, 100 models each, 20ms injected asynchronous catalog
I/O each, 15ms injected history I/O; no live-provider latency claims. The harness
counted I/O calls, peak overlapping loads, JSON size, and elapsed wall time.

| Mode | Before ms (5 samples) | After ms (5 samples) |
| --- | --- | --- |
| Name | 85.40, 79.62, 78.29, 77.64, 78.47 | 28.31, 21.65, 21.61, 21.23, 20.60 |
| Recency | 78.52, 77.67, 78.20, 77.95, 77.63 | 20.96, 21.74, 20.89, 20.90, 21.04 |
| Name + provider query | 77.75, 77.57, 77.95, 77.70, 77.62 | 20.42, 20.71, 20.54, 20.83, 20.85 |
| Provider-only | 78.01, 78.23, 77.44, 78.20, 78.16 | 0.31, 0.13, 0.11, 0.16, 0.12 |

Before, all four requests loaded all three catalogs serially and history once;
the old executor ignored the proposed provider-query/provider-only fields. After,
name loads history zero times; recency overlaps three catalogs and history;
provider query loads one catalog; provider-only does neither I/O. Peak catalog
overlap changes from 1 to 3 on broad calls. Name output decreases from 60,333 to
5,867 characters, retaining the rest through pagination; provider-only is 1,411.
These timings locate waiting/serialization costs under controlled injected I/O,
not CPU bottlenecks or real network percentiles. The first sample includes more
warmup; all samples are retained rather than presenting it as steady-state.

The retained name-mode samples have medians of 78.47ms before and 21.61ms after
(56.86ms lower; 72.5% in this fixture), with non-overlapping ranges. This is not a
production-latency promise.

### Behavioral limits

- Oversized results use compact pages, names opt-in, explicit continuation.
- Exact-ID empty results are expected: provider-only discovery now exposes valid IDs
  cheaply; exact IDs remain case-sensitive and unknown IDs are documented.
- Transient index unavailability uses explicit unavailable/null values. No hidden retry or stale cache is added to imply unavailable history is known.
- Request containment: propagate existing runtime cancellation; do not invent
  a timeout from synthetic latency measurements. An endpoint that never responds
  still needs caller cancellation or its own transport policy.
- Nested access: root dispatcher is the consumer in this increment; child
  agent-spec tool allowlists and recursive delegation authority are unchanged.
- Integration coverage: name mode, history overrides, concurrency, query
  prefiltering, pages, and real network cancellation now have integration evidence.
