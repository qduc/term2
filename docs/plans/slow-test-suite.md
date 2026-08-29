Status: plan.

# Slow test suite

## Problem

The default Vitest run takes about 77 seconds locally, which is too slow for
fast development feedback. It currently runs the complete source and scripts
test inventory together rather than providing a fast unit-test-only gate.

## Evidence captured 2026-08-29

The correctly configured full run uses `NODE_ENV=test` and completed with 7,009
passing tests, 2 pending tests, and 843 suites. Its observed wall time was
about 77 seconds.

Running the two included roots separately showed where the time goes:

| Scope | Wall time |
| --- | ---: |
| `vitest run source` | 71.0 s |
| `vitest run scripts` | 3.1 s |

The root configuration includes every matching test under both roots:

```ts
include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts']
```

The source suite contains 549 test files. A broad inventory found approximately
71 files using Ink/React rendering helpers, 84 files with explicit waits or
deadline/timer behavior, and 277 files touching process, filesystem, socket,
WebSocket, TLS, or other operating-system seams. These counts are indicators,
not a final classification of every test.

## Known slow cases

The slowest observed tests were:

- `source/cli.e2e.test.ts` — `starts the terminal UI and exits on Ctrl+C` —
  about 5.0 s;
- `scripts/provider-black-box/provider-record-security.test.ts` — provider
  credential-isolation scenario — about 3.4 s;
- several `source/cli.integration.test.ts` cases — about 1.5–2.3 s each;
- `source/tools/file/apply-patch.test.ts` — `execute: detailed error for
  context block mismatch` — about 1.5–1.6 s;
- `source/gateway/model-list.test.ts` — about 1.4 s;
- `source/gateway/server.test.ts` — TLS network transport case — about 1.2 s.

The `apply-patch` case is also a unit-test isolation problem. Its default
`createApplyPatchToolDefinition()` dependency uses `healPatchOperation`; a
context mismatch therefore enters the patch-healing provider path instead of
using a mocked healer. The test is measuring provider setup/timeout behavior
in addition to patch error formatting.

## Likely causes

1. The default command mixes unit, integration, and end-to-end tests.
2. Many source tests deliberately exercise real subprocess, filesystem,
   networking, gateway-restart, TLS, WebSocket, and timer behavior.
3. Ink/React tests repeatedly mount and render application components.
4. Hundreds of test files incur module transformation and worker/import-graph
   startup overhead. `it.sequential` only serializes tests within one file; it
   does not make the whole run sequential.
5. The TypeScript configuration uses the classic JSX transform (`jsx: react`),
   and React reports the outdated-transform warning during many render tests.
   This may add transform noise and overhead, but it is not yet established as
   the primary bottleneck.

## Future work

- Define a fast unit-test command that excludes integration and end-to-end
  tests without silently dropping important deterministic contract tests.
- Define explicit integration/e2e commands and keep the broader gate available
  before handoff or CI.
- Isolate the `apply-patch` failure-format tests from patch-healing provider
  execution by injecting a deterministic healing dependency where appropriate.
- Profile the source suite by test file and category before changing worker or
  JSX settings; do not optimize based only on the broad inventory counts.
- Preserve the existing full-suite gate and compare wall time and coverage of
  the new commands against this baseline.

## Acceptance criteria

- A documented unit command runs without provider/network/process side effects
  and is materially faster than the current full command.
- Integration and end-to-end tests remain runnable through explicit commands.
- The patch-healing error tests do not invoke a real provider.
- The full suite still passes with `NODE_ENV=test` after the split.


