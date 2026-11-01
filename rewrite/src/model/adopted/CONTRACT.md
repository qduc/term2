# Adopted model boundary

`index.ts` is the public adopted-model facade. It owns the exported binding and
registry contracts and preserves the existing exports. `registry.ts` owns provider
registry lifetime: binding cache, transport identity, helper references, detached
reads, abort-on-dispose, and exactly-once transport close. `conversion.ts` owns
stable item/request/output translation and item identity. `stream.ts` owns provider
request construction and completion/tool-call stream translation. The seams are
internal; callers continue to use the original facade and conversion export.

Disposal remains deferred until pending identity resolution and detached reads settle.
Borrowed transports are never closed by the adopted registry, while owned transports
close once after all helper references release. Provider dispatch observation remains
at the model stream boundary.

The repository root TypeScript project excludes `rewrite/`. Check this boundary
with `pnpm exec tsc -p rewrite/tsconfig.json --noEmit` as well as the source check.
Dispatch callbacks have the zero-argument `Model.stream` contract; checking only
the source project misses incompatible signatures in this adopted boundary.
