# Idle uncached-input confirmation removal

The idle-age and known resumed-session age exceptions were removed in
`6f473c19b`. A long wait alone provides too little evidence that a large
request will be uncached. The guard still considers the payload size and
signals such as provider changes, undo or rewind, and unknown resumed-session age.

After installing the workspace dependencies, run the focused decision probe from
the repository root:

```sh
node docs/experiments/idle-uncached-confirm/verify.mjs
```

It imports `LargeUncachedInputGuard` from
[src/session/large-uncached-input-guard.ts](../../../src/session/large-uncached-input-guard.ts)
and checks deterministic timestamps around the former idle threshold, a known
stale resume, and a provider-change warning. The probe exercises the decision
function. It uses synthetic inputs and makes no provider calls.

The original repair included a separate independent check of admission paths,
including control submit and steer. The [historical evidence](https://github.com/qduc/term2/tree/c455d16c56dfa1d46664c0b3183873100942bf65/docs/experiments/idle-uncached-confirm)
summarizes that check and the formatting rework. Its raw logs were external.
