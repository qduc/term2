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

A healthy run is roughly 20 seconds. It runs with `--bail=1` because the tests
drive the built CLI through a PTY and wait on its output: when the CLI cannot
start, every PTY test burns its full timeout instead of failing fast, and
`provider-session-resilience.blackbox.ts` alone holds 34 sequential tests. Bail
bounds that to one timeout. When you want the full failure list rather than the
first one, run vitest directly:

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
- `scripts/provider-black-box/provider-capability-matrix.ts` and
  `provider-session-capability-manifest.ts` own the test-side capability rows,
  typed lifecycle ledgers, and aggregate accounting.
- `scripts/provider-black-box/provider-session-responses.blackbox.ts`,
  `scripts/provider-black-box/provider-session-stateless.blackbox.ts`, and
  `scripts/provider-black-box/provider-session-resilience.blackbox.ts` own the
  stateful provider lifecycle scenarios and their exported ledger declarations.

## Adding or changing a scenario

- Assert semantic wire fields, roles, ordering, IDs, native reasoning/options,
  and authoritative completion/error events rather than full JSON snapshots.
- Keep fixtures minimal, deterministic, harmless, and derived from sanitized
  traffic. Never add real credentials, provider endpoints, or executable shell
  payloads.
- Cover both success and failure/incomplete-stream behavior. A provider must
  not turn a missing terminal event into empty success.
- Run the focused suite, fake-Codex E2E, relevant provider unit tests, and
  `pnpm typecheck`; run the full suite before handoff.
- For a regression fix, add or update a red-proof case when practical: apply
  the test-only change to the pre-fix parent and record that it fails before
  relying on green results after the fix.

The design and acceptance details live in `docs/plans/integration-test-improvement.md`; update the suite and this skill together when its workflow or ownership changes.
