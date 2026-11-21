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

1. **Run the real sandbox in CI.** The denied-read tests in
   `tests/tools/system/run-code/shell.integration.test.ts` use a fake
   `ShellSandboxRunner`. `tests/cli/sandbox-network.e2e.test.ts` runs only when
   `RUN_SHELL_SANDBOX_INTEGRATION=1`, which no workflow, script or `package.json`
   entry sets. No test shows the real sandbox refusing a write outside the
   workspace or a read of a credential path. Add one Linux check of each against
   the real runner, and set the gate variable in a lane that installs bubblewrap.
2. **Find out what the sandboxed e2e tests do in CI.** `ci.yml` passes
   `ripgrep: 'true'` to the setup action, which is what installs bubblewrap and
   socat, in the `test`, `integration` and `bench` jobs only. The `e2e` and
   `provider-black-box` jobs do not, yet `tests/cli/approval-mode.e2e.test.ts`
   runs there with the sandbox enabled. Whether those cases exercise a sandbox,
   skip, or pass for another reason is not known and should be established
   before item 1 is designed.
3. **Run the generated approval property in CI.** `approval.decision-table` in
   `scripts/generated-verification/approvals.mjs` asserts the route for all four
   `ApprovalHardGate` values in every approval mode. It runs only through
   `pnpm verify:generated`, which no workflow calls. Behavioural tests cover four
   of the sixteen gate and mode pairs: `question` and `denied-read` in `off`,
   `docker-host` in `unattended`, and `docker-host` in `off` behind
   `RUN_DOCKER_HOST_CONTROL_INTEGRATION=1` on macOS. Adding the generated run to
   the `quality` job covers the other twelve at route level for the cost of one
   step.
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

6. **Give Grok an adapter test.** `createGrokStreamedModel` is not run by any
   test. `tests/model/provider-affinity.integration.test.ts` exercises
   `buildGrokFetch` and asserts two request fields. Grok has no row in
   `provider-capability-matrix.ts`. Add a fake-server route that runs a turn
   through the built CLI with `--provider grok`, and assert the client-version
   header and the outdated-client rejection, since that rejection is the reason
   Grok can break without a Term2 change.
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
   WebSocket capture adapter `PROVENANCE.md` lists as outstanding; Grok; a direct
   `api.anthropic.com` capture; and `llama.cpp` with the local presets. OpenCode's
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
