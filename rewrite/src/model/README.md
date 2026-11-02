# Native provider boundary

`createProviderRegistry` in `provider.ts` implements the native `ModelRegistry`
contract from `index.ts` using registered source streamed-model factories. It
owns request/item translation; the engine owns recovery admission and history.
The historical engine owns its source transport pool and history conversion separately;
its transport lifetime differs from this native registry.

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
