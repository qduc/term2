# Settings reader contract

`index.ts` defines the one settings contract layers below `app/` see:
`SettingsReader`, with exact-key `get` and a `watch` that reports individual
changes, over branded `SettingKey`s and plain `SettingValue`s. It imports no
source service or settings schema.

Production settings are the source `SettingsService`, which `app/` constructs
(`app/settings.ts`, `createAppSettings`) and owns, with its directory, logger and
persistence policies. Tools read settings through `ToolContext.settings`;
`app/tool-surface.ts` builds that reader over the session's settings service, so
a tool sees the session's settings without importing the service.
