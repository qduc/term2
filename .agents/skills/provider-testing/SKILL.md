---
name: provider-testing
description: The provider black-box suite — how to run it, which file owns which scenario, and the assertion standards it holds scenarios to. Use for any change to providers, the provider bridge, the run loop, the provider registry, or non-interactive mode, and whenever adding or changing a black-box scenario or wire fixture.
---

# Provider Black-Box Suite

Provider, bridge, run-loop, registry, and non-interactive changes must use this suite as part of development. It protects the application-owned provider boundary and the shipped CLI against streaming, tool-call, history, reasoning, and error-path regressions.

Run it with:

```bash
pnpm test:provider-black-box
```

This command builds `dist/` first, then runs the dedicated configuration in `vitest.provider-black-box.config.ts`. It is intentionally separate from ordinary `pnpm test` because it launches the built CLI in isolated child processes.

Global setup primes a disposable Node compile cache with `dist/cli.js --help`
before starting the workers. Only compiled bytecode is shared: every scenario
still starts fresh processes and isolated application state. The cache is
removed on teardown and is disabled for V8 coverage or
`NODE_DISABLE_COMPILE_CACHE=1`. Direct Vitest invocations still require a prior
build. Integration launchers similarly share one emitted CLI build prepared by
their global setup; they do not reuse a running application.

Compare timing with a recent run on a similarly loaded host; a fixed healthy
duration becomes stale as PTY scenarios grow. The command uses `--bail=1`
because the tests drive the built CLI through a PTY and wait on its output:
when the CLI cannot start, each scenario can burn its full timeout, and
`provider-session-resilience.blackbox.ts` runs many scenarios sequentially.
Bail bounds that to one timeout. When you want the full failure list rather
than the first one, run vitest directly:

```bash
pnpm exec vitest run --config vitest.provider-black-box.config.ts
```

It also runs `--reporter=verbose`, because both the `default` and `minimal`
reporters print nothing until the summary when stdout is not a TTY — which is
how CI and agents run it, and why a slow run used to be indistinguishable from a
hung one. If a run seems to hang, look at the last streamed line: the next
scenario is the one whose CLI never reached the state it waits for.

## Suite ownership

- `scripts/provider-black-box/provider-contract.test.ts` obtains models through
  `source/providers/registry.ts`; do not bypass the registry by constructing
  transport classes directly.
- `scripts/provider-black-box/provider-cli.blackbox.ts` exercises the shipped
  `dist/cli.js` with isolated settings, filesystem state, stdout/stderr files,
  deadlines, and cleanup.
- `scripts/provider-black-box/fake-provider-http-server.ts` and
  `provider-wire-fixtures.ts` contain deterministic loopback HTTP/SSE fixtures.
- `scripts/provider-black-box/fake-provider-websocket-server.ts` owns the
  deterministic WebSocket replay fixture and its terminal/error assertions.
- `scripts/provider-black-box/provider-test-harness.ts` owns child-process,
  stateful PTY, isolated-workspace, restart, and temporary-environment lifecycle.
  Keep it asynchronous; synchronous child execution can deadlock the fake server.
  Interactive ready/idle waits use `child.waitForIdleInput()`, not a prompt
  glyph. The shipped CLI publishes an incrementing generation to
  `TERM2_HARNESS_IDLE_PATH` when the composer owns the keyboard and no turn is
  in flight (`source/lib/harness-input-idle.ts`). Text submission uses
  `writePtyTextAndSubmit()`, which waits for the CLI's companion composer-state
  acknowledgment before sending Enter; fixed sleeps and PTY echo do not prove
  Ink consumed the text. A PTY-stripped `❯` is not a readiness signal, and
  first-run/menu ownership must not count as idle.
- `scripts/provider-black-box/provider-capability-matrix.ts` and
  `provider-session-capability-manifest.ts` own the test-side capability rows,
  typed lifecycle ledgers, and aggregate accounting.
- `scripts/provider-black-box/provider-session-responses.blackbox.ts`,
  `provider-session-responses-tools.blackbox.ts`, and
  `provider-session-responses-failures.blackbox.ts` register the Responses
  continuity, tool, and failure groups from `provider-session-responses-scenarios.ts`.
  Vitest's file isolation gives each group separate fixture state and cleanup;
  scenarios within a file remain sequential. Keep file isolation enabled.
  The continuity entry retains the aggregate Responses ledger declaration.
- `scripts/provider-black-box/provider-session-stateless.blackbox.ts` owns the
  stateless lifecycle scenarios and its exported ledger declaration.
- `provider-session-resilience.blackbox.ts` and
  `provider-session-resilience-continuity.blackbox.ts` register transport and
  continuity groups from `provider-session-resilience-scenarios.ts`. They retain
  separate fixture state through file isolation; cases within a file stay
  sequential. The transport entry retains the aggregate resilience ledger.

CI uses `scripts/run-ci-lane.mjs` to distribute the complete tier inventories
across the same four jobs. Each lane schedules its files through isolated Vitest
projects using the original tier configurations and one two-worker queue.
Integration CLI launchers and provider suites use the job's freshly built,
bundled CLI; standalone integration runs still prepare a private build. E2E
retains its source and built-entry coverage. Discovery assigns new files automatically.
CI runs all assigned files after assertion failures and propagates collection,
test, and unhandled failures. The published local provider command above retains
`--bail=1`; it and the other full-suite commands remain available locally.

## Adding or changing a scenario

- Assert semantic wire fields, roles, ordering, IDs, native reasoning/options,
  and authoritative completion/error events rather than full JSON snapshots.
- Keep fixtures minimal, deterministic, harmless, and derived from sanitized
  traffic. Never add real credentials, provider endpoints, or executable shell
  payloads.
- Cover both success and failure/incomplete-stream behavior. A provider must
  not turn a missing terminal event into empty success.
- Run the focused suite, fake-Codex E2E, and `pnpm typecheck`. Provider changes
  are high risk under the `verification` skill and need an independent verifier.
  Provider unit tests no longer exist (tag `unit-suite-baseline`); don't add new
  ones.
- For a regression fix, add or update a red-proof case when practical: apply
  the test-only change to the pre-fix parent and record that it fails before
  relying on green results after the fix.

The design and acceptance details live in `docs/plans/engineering/integration-test-improvement.md`; update the suite and this skill together when its workflow or ownership changes.
