# Scoped settings

`createScopedSettings` implements the config layer's `SettingsWriter` contract over
storage operations, without importing a source service, runtime settings schema,
or historical engine identity. The storage owner validates writes and throws when
a requested persistent write was not saved.

Each view copies its readable/writable allowlists and override values. Exact-key
`settings.get` is distinct from `readPath`, which projects authorized descendants
for callers reading a parent object. Returned objects are snapshots. `settings.watch`
reports individual changes; `observe` reports a batch of changed readable keys.
Observers are passive, suppress unchanged values, and return an unsubscribe.

`origin` distinguishes hidden, overlay, and storage-backed reads without naming a
source-service provenance enum. `replaceOverride` is a silent overlay update for
an owner that performs its own accepted-runtime refresh; ordinary writes notify
subscribers. Runtime model/reasoning/temperature translation and source-service
pair identity remain in the historical engine boundary, not in config.
