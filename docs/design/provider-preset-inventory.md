# Provider preset inventory

`source/providers/provider-presets.json` describes setup templates, not configured
connections or a ranking of services. The Add Provider menu validates it through
`parseProviderInventory`, sorts entries alphabetically, and searches by name and
category. The selected entry links to its service documentation.

## Adding a preset

An entry needs a unique `id`, display `name`, `category`, and `docsUrl`. Ordinary
endpoint presets additionally supply `type` and `baseUrl`. `type` must be one of
`KNOWN_CUSTOM_PROVIDER_TYPES` in the settings schema. Adding a template for an
existing adapter requires JSON only; a new authentication flow or wire protocol
still requires adapter code.

Categories are `model-api`, `gateway`, `inference`, `local`, and `subscription`.
Plan and region variants are separate entries with explicit labels and unique IDs.
The first inventory includes international API defaults and a separate Z.AI Coding
Plan endpoint; it does not silently infer billing plans from credentials.

Do not add credentials, executable expressions, or model lists. The validator
rejects unknown fields, unsupported adapter types, duplicate IDs, and non-HTTP(S)
URLs. Model discovery remains owned by the connection's adapter/model service.

## Saved connections and compatibility

Ordinary endpoint templates copy their defaults into the existing custom-provider
editor. Users can change the name, URL, adapter type, and key before saving. A
second copy gets a collision-free suggested name. Saved connections persist their
own values, without a live reference to the inventory. Local loopback credentials
follow the existing credential policy rather than a special inventory exemption.

`builtinProviderId` entries instead open an already registered provider's existing
key or account setup. They must not also contain `type` or `baseUrl`. This retains
OpenAI/OpenRouter's native adapters and existing credential storage and preserves
Codex/Grok OAuth account handling. These legacy built-ins still have fixed
identities and their existing management restrictions; this change does not
migrate them to independently named/removable custom connections.

Your Providers lists custom connections (including ones missing credentials) and
credential-ready built-ins. Missing built-in credentials are configured through
Add Provider. Disabled connections retain their existing visibility policy.

## Evidence limits

Inventory presence means a documented endpoint template for a supported adapter,
not a claim of a successful live-provider canary or guaranteed tool support for
every model returned by that service. Enterprise cloud flows needing additional
authentication/deployment configuration are not offered as URL/key-only presets.

Candidate coverage was informed by [Models.dev](https://models.dev/providers/)
and [OpenCode's provider directory](https://opencode.ai/docs/providers/), inspected
2026-10-19. Ecosystem presence is not API market share. Each inventory entry links
to its service documentation for current account and endpoint requirements.
