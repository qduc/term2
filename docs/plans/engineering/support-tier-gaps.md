# Close the Core check gaps

Status: plan. Waiting on the maintainer to choose the order, and on provider
credentials for the items marked "needs a live recording".

[Support tiers](../../reference/support-tiers.md) promises that every Core item
has at least one automated check that fails when the item breaks. This plan
lists where that promise does not hold and what closes each gap.

## How the gaps were found

Three read-only passes over `tests/`, `scripts/provider-black-box/` and the CI
workflows at commit `a96ecc7`, each opening the tests and recording which
assertion would fail. No test was run, so a gap here means "no asserting test
was found", and a covered item means "an asserting test exists", not "it passes".
The claims each work item rests on were re-checked with `grep` and are stated
with the symbol or file a reader can search for.

Surfaces and TUI commands are well covered by the e2e files under `tests/cli/`
and are mostly absent from this list for that reason.

## Work items, in proposed order

Ordered by what a miss costs, then by how likely the miss is.

### 1. Safety checks that do not run

1. **Strengthen and extend the real-sandbox checks.** One check does run the
   real sandbox: the case "bare retains the outside-workspace edit approval
   boundary without asking headlessly" in `tests/cli/cli.integration.scenarios.ts`
   writes outside the workspace through the built CLI with default settings and
   asserts the file is absent. `cli-headless.integration.test.ts` runs it in the
   `test` lane, which installs bubblewrap, and `publish.yml` runs it again. An
   earlier version of this plan said no such test existed; that was wrong. What
   is still missing:
   - Its other assertion is `toMatch(/exit [1-9]/)`, which a failure unrelated
     to the sandbox would also satisfy. It should assert the denial itself.
   - No test shows the real sandbox refusing a read of a credential path. The
     denied-read tests in `tests/tools/system/run-code/shell.integration.test.ts`
     use a stub `ShellSandboxRunner` that prints "Permission denied".
   - The network policy is unchecked. `tests/cli/sandbox-network.e2e.test.ts`
     runs only when `RUN_SHELL_SANDBOX_INTEGRATION=1`, which nothing sets, and
     setting it is not enough: the file belongs to the `e2e` lane, which runs on
     `ubuntu-latest` without bubblewrap or socat, and a comment in `publish.yml`
     records that Ubuntu 24.04 runners reject bubblewrap's loopback setup. The
     test has to move to a lane on `ubuntu-22.04` with the binaries installed.
   - The ACP shell cases in `tests/clients/acp/v1.integration.test.ts` and
     `tests/clients/acp-v2/serve.integration.test.ts` accept either a sandboxed
     result or a refusal, so they pass whether or not the sandbox ran.
     `TERM2_ACP_REQUIRE_SHELL_SUCCESS=1` makes success mandatory and nothing
     sets it.
2. **Answered: the `e2e` and `provider-black-box` lanes need no real sandbox.**
   Those jobs install no sandbox binaries, and none of their tests depends on
   one. `tests/cli/approval-mode.e2e.test.ts` and the provider scenarios call
   the shell with `sandbox: 'unsandboxed'`, which goes to approval without
   reaching the runner. `tests/cli/unattended-approval.e2e.test.ts` puts stub
   `bwrap`, `socat` and `rg` executables on `PATH` (`sandboxShims`) so that
   availability reports true. The remaining e2e files disable the sandbox. So
   these lanes test approval routing around the sandbox setting, and the
   sandbox itself is exercised only by the checks in item 1.
3. **Decided: the generated properties run in CI.** The `quality` job runs
   `pnpm verify:generated --seed 424242`: ten properties from
   `scripts/generated-verification/run.mjs`, six of them about approvals. The
   maintainer authorized it on 2026-11-21, which the pilot's `PLAN.md` required
   before any CI use. Before it was added, a seeded change that stopped
   `docker-host` from routing as a hard gate failed `approval.decision-table`
   on its sixth case. A full run with a fixed
   seed took about 17 seconds in a cloud container with no build, passed at
   `49edfe662`, and two runs with the same seed produced the same report apart
   from timings. Two limits on what it adds. `approval.decision-table` does not assert a route per
   gate: it generates request shapes at random and asserts on whether any hard
   gate applies, so each pairing of an `ApprovalHardGate` with an approval mode
   is covered only as often as 1,000 random cases happen to produce it. And
   behavioural tests still cover four of the sixteen pairs: `question` and
   `denied-read` in `off`, `docker-host` in `unattended`, and `docker-host` in
   `off` behind `RUN_DOCKER_HOST_CONTROL_INTEGRATION=1` on macOS. The pilot's
   `README.md` now gives the registered count.
4. **Check the workspace write boundary.** The home-directory warning is tested
   in `tests/cli/cli.integration.scenarios.ts`; nothing asserts that a write
   outside the launch directory is refused or asked about.
5. **Check the shell and output limits.** No test sets or asserts
   `shell.timeout`, `shell.backgroundTimeout` or `agent.maxStreamOutputChars`.

### 2. Providers

Every built-in provider and custom type except `opencode` is Core. No automated check contacts a
real provider: pull-request CI is offline, `publish.yml` runs the static guards
and `pnpm test:integration`, and the one scheduled workflow,
`model-catalog-update.yml`, fetches the OpenRouter model list without sending a
model request. That stays the case by decision (item 13); the aim of this
section is a real recording behind every provider, replayed offline.

6. **Grok now has adapter tests; what they leave out.**
   `provider-session-grok.blackbox.ts` and `provider-session-grok-client.blackbox.ts`
   run the built CLI with `--provider grok` against a loopback server, with a
   real `grok-auth.json` under an isolated config directory and the provider's
   own client-version lookup running unmodified, and Grok has a `grok-http` row
   in `provider-capability-matrix.ts`. They assert the `x-grok-client-version`
   header and where its value comes from (cache, installed `grok`, built-in
   constant), the conversation headers, `GROK_BASE_URL`, the lifecycle
   scenarios, and that a 426 from the proxy fails the run after one request.
   Grok does not chain responses, so its two-turn scenario asserts a full
   history replay. Not covered: the live fetch of the current client version
   and its cache write-back, token refresh through the provider, and credential
   import from `GROK_HOME`. Grok still has no recorded traffic (item 7).
   Writing the tests surfaced product behaviour worth a decision:
   - A 426 reaches the user as the SDK's text, "426 Your Grok CLI version is
     outdated", with nothing saying what to do about it. Term2 is the client
     here, so the remedy is a Term2 or version-cache update, not a Grok CLI one.
   - On the same failure a `--json` run emits a `final` event with empty
     `finalText` before the `error` event.
   - An incomplete Grok stream is reported as "OpenAI streamed response ended
     without a completion."
   - `GROK_BASE_URL` redirects model requests but not `fetchGrokModels`.
   - A lead, not yet confirmed: when the 426 was temporarily made retryable
     with `agent.retryAttempts` at 2, the server saw six requests, which
     suggests two retry layers multiplying.
7. **Record what has only been faked.** Recorded fixtures exist for OpenAI over
   HTTP, Google, OpenCode's Chat and Anthropic protocols, and, recorded through
   OpenRouter, the `openai-compatible`, custom `openai` and `anthropic` custom
   types (`fixtures/openai-compatible-openrouter/`, `fixtures/openai-type-openrouter/`
   and `fixtures/anthropic-openrouter/`, each replayed by a test in
   `provider-contract.test.ts`). Those three show that each type's own adapter
   path handles a real service speaking that wire format; they are not captures
   of any other vendor's server, and `PROVENANCE.md` says so per fixture. For this
   probe the two chat types send identical requests, so the pair does not yet
   exercise anything that differs between them. Still checked against
   hand-written servers only: Codex and OpenAI over WebSocket, which wait on the
   WebSocket capture adapter `PROVENANCE.md` lists as outstanding; Grok; and
   `llama.cpp` with the local presets. A direct `api.anthropic.com` capture now
   exists (`fixtures/anthropic/`), but the model produced no thinking block in
   it, and the capture that does contain thinking blocks came through
   OpenRouter. No fixture therefore shows whether Anthropic's own API accepts a
   tool continuation whose request omits the preceding thinking block, which is
   what the `anthropic` adapter sends. That needs a probe that makes the model
   think before it calls the tool. OpenCode's
   Responses protocol is also unrecorded; `opencode` is Supported and the
   maintainer has no account, so it stays so.
8. **Re-prepare the older fixtures.** `openrouter/tool-continuation-v1.json` was
   replaced by a live capture of both sides, which closes the gap this item
   used to describe. What remains: `sanitizeFixtureEnvelope` used to write each
   live provider id as a key of the committed `placeholders` table. That is
   fixed for new fixtures, but the fixtures under `fixtures/openai/`,
   `fixtures/google/` and `fixtures/opencode/` were prepared before the fix and
   still carry live request and response ids there. They are identifiers, not
   credentials. Fixtures are never edited by hand, so removing them means
   running `pnpm provider:fixture:prepare --accept` again on the raw recordings,
   which are kept outside the repository.
9. **Test the login flows.** No test references `--codex-login`, `--grok-login`
   or the PKCE code. Token refresh and account pinning are covered by
   `tests/model/oauth-refresh.integration.test.ts` and
   `oauth-account-ownership.integration.test.ts`. A loopback authorization
   server, as the refresh tests already use, would cover login.
10. **Remove the error-scenario exclusions or justify them per type.** The
    capability matrix marks `native-error` and `incomplete-stream` as excluded
    for `runtime-openai-chat`, `runtime-llama-cpp-chat` and both OpenCode rows,
    on the grounds that a representative route covers the protocol. That was a
    reasonable economy when those types were not each Core. It still is for the
    OpenCode rows, which are Supported; the first two are Core types.
11. **Derive the capability ledger from what ran.** The executed-scenario lists
    in `provider-session-capability-manifest.ts` are hand-written constants, so
    deleting a scenario test does not fail `provider-capability-matrix.test.ts`.
12. **Check API keys from the environment.** Only `OPENAI_API_KEY` is asserted,
    in `tests/model/providers/openai-catalog.integration.test.ts`.
13. **Decided against: a scheduled check against the real services.** The
    maintainer chose one-time recordings replayed in CI as sufficient. The
    consequence is accepted, not solved: a replayed recording fails when Term2's
    side changes, and cannot fail when a provider changes its wire format or
    auth under an unchanged Term2. That kind of break is found by using the
    provider. Recapture a fixture when such a break is found, and when
    `fixture-drift.test.ts` reports that the SDK a fixture was recorded with has
    moved.

### 3. Saved data across upgrades

14. **Keep fixtures written by past releases.** No test loads a conversation
    log, settings file, credential file or memory store produced by an older
    release; every "old" input is constructed inside its test, as in
    `tests/session/conversation/migration-source.integration.test.ts`. Commit one
    of each from the current release and assert that later releases load them.
15. **Test the version rejection.** The reader throws on a `v` other than
    `LOG_FORMAT_VERSION`; no test references that path.
16. **Decide whether `settings.json` gets a version field.** It has none, so an
    incompatible change cannot be detected on load.
17. **Test the automatic triggers.** The compaction tests use `/compact` with
    automatic compaction disabled, and no test sets `agent.sessionRollover.*`.
    Both features are Core because they run unprompted, and the unprompted path
    is the untested one.

### 4. Release

18. **Gate the publish on the packed artifact.** `publish.yml` builds, runs the
    guards and the integration tier, and publishes. `scripts/release-smoke.ts`,
    which installs the tarball outside the repository and replays a recorded
    turn, is run by hand and has one fixture, for Google.

### 5. Small Core items without a check

- `/settings reset`, the `-r` short flag and `--show-reasoning`: not run by a test.
- `grep` and `glob`: only their error paths are asserted.
- Environment overrides: three of the entries in `SETTING_ENV_VARIABLES` are
  asserted, in `tests/config/approval-restart.integration.test.ts`.
- Skins: `tests/cli/cli.e2e.test.ts` waits for the composer under each skin and
  asserts nothing about layout.

## Supported items with no check found

Not release-blocking, listed so the tier is honest: remote SSH sessions, the
background shell job tools, `read_code_outline` and `code_context_search`,
`enter_worktree` and `exit_worktree`, `activate_skill`, `propose_goal`,
`ask_mentor` and the mentor role, `/goal` typed in the TUI, `/handoff`,
`/restart`, the budget panel, input history, background check-ins and the
headless wait limit, and web search beyond the tool being offered. MCP, tool
toggles and the memory tools had no check in the directories that were read;
`tests/app/memory/`, `tests/cli/quiet-profile.e2e.test.ts` and the ACP tests
mention them and were not opened.
